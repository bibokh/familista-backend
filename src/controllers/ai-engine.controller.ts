// Familista — AI Decision Engine
// File location: src/controllers/ai-engine.controller.ts
//
// Consolidated HTTP handlers. Sections (ToC):
//   1.  Model registry
//   2.  Player decisions
//   3.  Coach decisions
//   4.  Club decisions
//   5.  Franchise decisions
//   6.  Investor decisions
//   7.  Executive decisions
//   8.  Decision history + getById + summary
//   9.  Review / feedback / outcomes
//  10.  Audit
//  11.  Bootstrap (seed default models)

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import * as registry from '../services/ai-model-registry.service';
import * as playerDec from '../services/ai-player-decisions.service';
import * as coachDec from '../services/ai-coach-decisions.service';
import * as clubDec from '../services/ai-club-decisions.service';
import * as franchiseDec from '../services/ai-franchise-decisions.service';
import * as investorDec from '../services/ai-investor-decisions.service';
import * as execDec from '../services/ai-executive-decisions.service';
import * as history from '../services/ai-decision-history.service';
import * as feedback from '../services/ai-feedback.service';
import * as audit from '../services/ai-audit.service';
import { reviewDecision } from '../services/ai-orchestrator.service';
import { seedDefaultAIModels } from '../data/ai-models.seed';
import {
  assertSubjectAccess,
  assertPlatformAdmin,
} from '../middleware/ai-access.middleware';

import {
  createModelSchema,
  updateModelSchema,
  activateModelSchema,
  reviewDecisionSchema,
  submitFeedbackSchema,
  recordOutcomeSchema,
  historyQuerySchema,
  aiAuditQuerySchema,
} from '../utils/ai-engine.validators';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { BadRequestError, ForbiddenError } from '../utils/errors';

function actorOf(req: Request) {
  if (!req.aiActor) throw new ForbiddenError('AI context required');
  return req.aiActor;
}
function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.join('.') || 'body'}: ${e.message}`).join(', '));
}
function callOpts(req: Request) {
  return {
    useLlm: req.body?.useLlm === false ? false : undefined,
    persist: req.body?.persist === false ? false : undefined,
    cacheTtlSec: req.body?.cacheTtlSec !== undefined ? Number(req.body.cacheTtlSec) : undefined,
  };
}

// ─── 1. Model registry ──────────────────────────────────────────────────────

export async function listModels(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await registry.listModels({
      domain: req.query.domain as never,
      decisionType: req.query.decisionType as never,
      activeOnly: req.query.activeOnly === 'true',
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getModel(req: Request, res: Response, next: NextFunction) {
  try { actorOf(req); return sendSuccess(res, await registry.getModel(req.params.id)); }
  catch (err) { return next(err); }
}

export async function createModel(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertPlatformAdmin(actor);
    const input = createModelSchema.parse(req.body);
    return sendCreated(res, await registry.createModel(actor, input), 'Model registered');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateModel(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertPlatformAdmin(actor);
    const input = updateModelSchema.parse(req.body);
    return sendSuccess(res, await registry.updateModel(actor, req.params.id, input), 'Model updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function activateModel(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertPlatformAdmin(actor);
    const input = activateModelSchema.parse(req.body ?? {});
    return sendSuccess(res, await registry.activateModel(actor, req.params.id, input), 'Model activated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function deprecateModel(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertPlatformAdmin(actor);
    const reason = String(req.body?.reason ?? '');
    if (!reason) throw new BadRequestError('reason required');
    return sendSuccess(res, await registry.deprecateModel(actor, req.params.id, reason), 'Model deprecated');
  } catch (err) { return next(err); }
}

// ─── 2. Player decisions ────────────────────────────────────────────────────

export async function predictInjuryRisk(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Player', req.params.playerId);
    return sendCreated(res, await playerDec.predictInjuryRisk(actor, req.params.playerId, callOpts(req)), 'Decision generated');
  } catch (err) { return next(err); }
}
export async function analyzePlayerGrowth(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Player', req.params.playerId);
    return sendCreated(res, await playerDec.analyzePlayerGrowth(actor, req.params.playerId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function detectTalent(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Player', req.params.playerId);
    return sendCreated(res, await playerDec.detectTalent(actor, req.params.playerId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function predictFatigue(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Player', req.params.playerId);
    return sendCreated(res, await playerDec.predictFatigue(actor, req.params.playerId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function recommendTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Player', req.params.playerId);
    return sendCreated(res, await playerDec.recommendTransfer(actor, req.params.playerId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function optimizeTraining(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Player', req.params.playerId);
    return sendCreated(res, await playerDec.optimizeTraining(actor, req.params.playerId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function recommendLineup(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Match', req.params.matchId);
    return sendCreated(res, await playerDec.recommendLineup(actor, req.params.matchId, callOpts(req)));
  } catch (err) { return next(err); }
}

// ─── 3. Coach decisions ─────────────────────────────────────────────────────

export async function recommendTactics(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Match', req.params.matchId);
    return sendCreated(res, await coachDec.recommendTactics(actor, req.params.matchId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function optimizeFormation(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Match', req.params.matchId);
    return sendCreated(res, await coachDec.optimizeFormation(actor, req.params.matchId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function analyzeOpponent(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Match', req.params.matchId);
    return sendCreated(res, await coachDec.analyzeOpponent(actor, req.params.matchId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function prepareMatch(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Match', req.params.matchId);
    return sendCreated(res, await coachDec.prepareMatch(actor, req.params.matchId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function recommendSubstitution(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Match', req.params.matchId);
    return sendCreated(res, await coachDec.recommendSubstitution(actor, req.params.matchId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function generateTrainingPlan(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Club', req.params.clubId);
    return sendCreated(res, await coachDec.generateTrainingPlan(actor, req.params.clubId, callOpts(req)));
  } catch (err) { return next(err); }
}

// ─── 4. Club decisions ──────────────────────────────────────────────────────

export async function predictFinancialHealth(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Club', req.params.clubId);
    return sendCreated(res, await clubDec.predictFinancialHealth(actor, req.params.clubId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function optimizeBudget(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Club', req.params.clubId);
    return sendCreated(res, await clubDec.optimizeBudget(actor, req.params.clubId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function alertSalaryRisk(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Club', req.params.clubId);
    return sendCreated(res, await clubDec.alertSalaryRisk(actor, req.params.clubId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function recommendSponsorship(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Club', req.params.clubId);
    return sendCreated(res, await clubDec.recommendSponsorship(actor, req.params.clubId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function supportTransferMarket(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'Club', req.params.clubId);
    return sendCreated(res, await clubDec.supportTransferMarket(actor, req.params.clubId, callOpts(req)));
  } catch (err) { return next(err); }
}

// ─── 5. Franchise decisions ─────────────────────────────────────────────────

export async function recommendRegionalExpansion(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'FranchiseUnit', req.params.unitId);
    return sendCreated(res, await franchiseDec.recommendRegionalExpansion(actor, req.params.unitId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function predictAcademyProfitability(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'FranchiseUnit', req.params.unitId);
    return sendCreated(res, await franchiseDec.predictAcademyProfitability(actor, req.params.unitId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function analyzeTerritoryRisk(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'FranchiseUnit', req.params.unitId);
    return sendCreated(res, await franchiseDec.analyzeTerritoryRisk(actor, req.params.unitId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function scoreOperatorPerf(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'FranchiseUnit', req.params.unitId);
    return sendCreated(res, await franchiseDec.scoreOperatorPerf(actor, req.params.unitId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function scoreFranchiseInvestmentOpportunity(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'FranchiseUnit', req.params.unitId);
    return sendCreated(res, await franchiseDec.scoreFranchiseInvestmentOpportunity(actor, req.params.unitId, callOpts(req)));
  } catch (err) { return next(err); }
}

// ─── 6. Investor decisions ──────────────────────────────────────────────────

export async function predictInvestorRoi(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'InvestorProfile', req.params.investorId);
    return sendCreated(res, await investorDec.predictInvestorRoi(actor, req.params.investorId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function scoreInvestmentRisk(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'InvestorProfile', req.params.investorId);
    return sendCreated(res, await investorDec.scoreInvestmentRiskFor(actor, req.params.investorId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function suggestValuation(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'InvestmentEntity', req.params.entityId);
    return sendCreated(res, await investorDec.suggestValuation(actor, req.params.entityId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function optimizeCapitalAllocation(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'InvestorProfile', req.params.investorId);
    return sendCreated(res, await investorDec.optimizeCapitalAllocation(actor, req.params.investorId, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function recommendAcquisition(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertSubjectAccess(actor, 'InvestmentEntity', req.params.entityId);
    return sendCreated(res, await investorDec.recommendAcquisition(actor, req.params.entityId, callOpts(req)));
  } catch (err) { return next(err); }
}

// ─── 7. Executive decisions ─────────────────────────────────────────────────

export async function generateCeoDashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertPlatformAdmin(actor);
    return sendCreated(res, await execDec.generateCeoDashboard(actor, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function generateBoardStrategy(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertPlatformAdmin(actor);
    return sendCreated(res, await execDec.generateBoardStrategy(actor, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function rankExpansionOpportunities(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertPlatformAdmin(actor);
    return sendCreated(res, await execDec.rankExpansionOpportunities(actor, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function predictMarketEntry(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertPlatformAdmin(actor);
    return sendCreated(res, await execDec.predictMarketEntry(actor, callOpts(req)));
  } catch (err) { return next(err); }
}
export async function evaluateAcquisitionTarget(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertPlatformAdmin(actor);
    return sendCreated(res, await execDec.evaluateAcquisitionTarget(actor, req.params.entityId, callOpts(req)));
  } catch (err) { return next(err); }
}

// ─── 8. Decision history ────────────────────────────────────────────────────

export async function searchHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const q = historyQuerySchema.parse(req.query);
    return sendSuccess(res, await history.search(actor, q));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function summarizeHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const q = historyQuerySchema.parse(req.query);
    return sendSuccess(res, await history.summarize(actor, q));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function getDecision(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await history.getDecision(actor, req.params.id));
  } catch (err) { return next(err); }
}

// ─── 9. Review + feedback + outcomes ────────────────────────────────────────

export async function reviewDecisionHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = reviewDecisionSchema.parse(req.body);
    return sendSuccess(res, await reviewDecision(actor, req.params.id, input.status, input.notes), 'Decision reviewed');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function submitFeedback(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = submitFeedbackSchema.parse(req.body);
    return sendCreated(res, await feedback.submitFeedback(actor, req.params.id, input), 'Feedback recorded');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function recordOutcome(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = recordOutcomeSchema.parse(req.body);
    await feedback.recordOutcome(actor, req.params.id, input);
    return sendNoContent(res);
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function listFeedback(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await feedback.listFeedback(req.params.id));
  } catch (err) { return next(err); }
}

export async function modelFeedbackStats(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertPlatformAdmin(actor);
    return sendSuccess(res, await feedback.modelFeedbackStats(req.params.modelId));
  } catch (err) { return next(err); }
}

// ─── 10. Audit ──────────────────────────────────────────────────────────────

export async function searchAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertPlatformAdmin(actor);
    const q = aiAuditQuerySchema.parse(req.query);
    return sendSuccess(res, await audit.searchAIAudit(q));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function summarizeAudit(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertPlatformAdmin(actor);
    const q = aiAuditQuerySchema.parse(req.query);
    return sendSuccess(res, await audit.summarizeAIAudit(q));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 11. Bootstrap ──────────────────────────────────────────────────────────

export async function seedModels(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    assertPlatformAdmin(actor);
    const result = await seedDefaultAIModels(actor.userId);
    return sendSuccess(res, result, 'Default AI models seeded');
  } catch (err) { return next(err); }
}
