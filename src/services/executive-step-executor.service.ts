// Familista — Executive OS · Integration Layer
// File location: src/services/executive-step-executor.service.ts
//
// The central cross-engine dispatcher. Workflow steps describe what to do as
// (engine, action) tuples; this executor resolves them to concrete calls into
// the franchise / investor / AI / admin / white-label / executive services
// that already exist. NO BUSINESS LOGIC LIVES HERE — only routing.
//
// Adding a new step type:
//   1. Add a StepActionId in executive.types.ts.
//   2. Register a handler in the HANDLERS map below.
//   3. Reference it in a workflow template (or in a custom workflow's steps).

import { prisma } from '../lib/prisma';

import * as franchiseExpansion from './franchise-expansion.service';
import * as franchiseOwnership from './franchise-ownership.service';
import * as franchisePerformance from './franchise-performance.service';
import * as franchiseCompliance from './franchise-compliance.service';

import * as investorInvestment from './investor-investment.service';
import * as investorRound from './investor-round.service';
import * as investorEntity from './investor-entity.service';
import * as investorExit from './investor-exit.service';
import * as investorDistribution from './investor-distribution.service';

import * as adminBranding from './admin-branding.service';
import * as adminOrganization from './admin-organization.service';

import * as playerDec from './ai-player-decisions.service';
import * as clubDec from './ai-club-decisions.service';
import * as franchiseDec from './ai-franchise-decisions.service';
import * as investorDec from './ai-investor-decisions.service';

import type { AIActor } from '../types/ai-engine.types';
import type { FranchiseActor } from '../types/franchise.types';
import type { InvestorActor } from '../types/investor.types';
import type { PlatformActor } from '../types/admin.types';
import type { StepActionId, StepExecutionResult } from '../types/executive.types';
import type { ExecutiveActor } from '../types/executive.types';

function asFranchiseActor(actor: ExecutiveActor): FranchiseActor {
  return {
    userId: actor.userId,
    scope: {
      isPlatformAdmin: true,
      platformRole: actor.scope.platformRole ?? 'PLATFORM_ADMIN',
      readableUnitIds: new Set(),
      writableUnitIds: new Set(),
      primaryUnitIds: new Set(),
      ownerIds: new Set(),
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  };
}

function asInvestorActor(actor: ExecutiveActor): InvestorActor {
  return {
    userId: actor.userId,
    scope: {
      isPlatformAdmin: true,
      platformRole: actor.scope.platformRole ?? 'PLATFORM_ADMIN',
      investorId: null,
      ownedEntityIds: new Set(),
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  };
}

function asAIActor(actor: ExecutiveActor): AIActor {
  return {
    userId: actor.userId,
    scope: {
      isPlatformAdmin: true,
      platformRole: actor.scope.platformRole ?? 'PLATFORM_ADMIN',
      userId: actor.userId,
      clubId: actor.scope.clubId,
      userRole: 'PLATFORM_ADMIN',
      investorId: null,
      franchiseUnitIds: new Set(),
      entityIds: new Set(),
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  };
}

function asPlatformActor(actor: ExecutiveActor): PlatformActor {
  return {
    adminId: 'executive-os',
    userId: actor.userId,
    role: actor.scope.platformRole ?? 'PLATFORM_ADMIN',
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    mfaVerifiedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler registry
// ─────────────────────────────────────────────────────────────────────────────

type StepHandler = (actor: ExecutiveActor, params: Record<string, unknown>) => Promise<StepExecutionResult>;

function need<T>(params: Record<string, unknown>, key: string): T {
  const v = params[key];
  if (v === undefined || v === null) throw new Error(`Missing required param "${key}"`);
  return v as T;
}

const HANDLERS: Record<StepActionId, StepHandler> = {
  // ─ Franchise ────────────────────────────────────────────────────────────
  'FRANCHISE.CREATE_EXPANSION_REQUEST': async (actor, p) => {
    const result = await franchiseExpansion.createExpansionRequest(asFranchiseActor(actor), p as never);
    return { ok: true, data: { expansionRequestId: result.id, status: result.status } };
  },
  'FRANCHISE.DECIDE_EXPANSION_REQUEST': async (actor, p) => {
    const result = await franchiseExpansion.decideExpansionRequest(asFranchiseActor(actor), need(p, 'id'), p as never);
    return { ok: true, data: { id: result.id, status: result.status } };
  },
  'FRANCHISE.COMPLETE_EXPANSION_REQUEST': async (actor, p) => {
    const result = await franchiseExpansion.completeExpansionRequest(asFranchiseActor(actor), need(p, 'id'), p as never);
    return { ok: true, data: { expansionRequestId: result.request.id, newUnitId: result.unit.id } };
  },
  'FRANCHISE.CREATE_ACQUISITION_REQUEST': async (actor, p) => {
    const result = await franchiseExpansion.createAcquisitionRequest(asFranchiseActor(actor), p as never);
    return { ok: true, data: { acquisitionId: result.id, status: result.status } };
  },
  'FRANCHISE.SUBMIT_ACQUISITION': async (actor, p) => {
    const result = await franchiseExpansion.submitAcquisitionRequest(asFranchiseActor(actor), need(p, 'id'));
    return { ok: true, data: { id: result.id, status: result.status } };
  },
  'FRANCHISE.DECIDE_ACQUISITION': async (actor, p) => {
    const result = await franchiseExpansion.decideAcquisition(asFranchiseActor(actor), need(p, 'id'), p as never);
    return { ok: true, data: { id: result.request.id, transferId: result.transfer?.id ?? null } };
  },
  'FRANCHISE.INITIATE_TRANSFER': async (actor, p) => {
    const result = await franchiseOwnership.initiateTransfer(asFranchiseActor(actor), need(p, 'unitId'), p as never);
    return { ok: true, data: { transferId: result.id } };
  },
  'FRANCHISE.EXECUTE_TRANSFER': async (actor, p) => {
    const result = await franchiseOwnership.executeTransfer(asFranchiseActor(actor), need(p, 'transferId'));
    return { ok: true, data: { transferId: result.transfer.id, newOwnershipId: result.newOwnership.id } };
  },
  'FRANCHISE.GENERATE_SNAPSHOT': async (actor, p) => {
    const result = await franchisePerformance.generateSnapshot(asFranchiseActor(actor), need(p, 'unitId'), p as never);
    return { ok: true, data: { snapshotId: result.id, period: result.period } };
  },
  'FRANCHISE.UPSERT_COMPLIANCE_CHECK': async (actor, p) => {
    const result = await franchiseCompliance.upsertComplianceCheck(asFranchiseActor(actor), need(p, 'unitId'), p as never);
    return { ok: true, data: { id: result.id, status: result.status } };
  },

  // ─ Investor ─────────────────────────────────────────────────────────────
  'INVESTOR.CREATE_INVESTMENT': async (actor, p) => {
    const result = await investorInvestment.createInvestment(asInvestorActor(actor), p as never);
    return { ok: true, data: { investmentId: result.id, status: result.status } };
  },
  'INVESTOR.FUND_INVESTMENT': async (actor, p) => {
    const result = await investorInvestment.fundInvestment(asInvestorActor(actor), need(p, 'investmentId'), p as never);
    return { ok: true, data: { investmentId: result.id, fundedAmount: result.fundedAmount, status: result.status } };
  },
  'INVESTOR.CREATE_ROUND': async (actor, p) => {
    const result = await investorRound.createRound(asInvestorActor(actor), need(p, 'entityId'), p as never);
    return { ok: true, data: { roundId: result.id, status: result.status } };
  },
  'INVESTOR.OPEN_ROUND': async (actor, p) => {
    const result = await investorRound.openRound(asInvestorActor(actor), need(p, 'id'), (p as never) ?? {});
    return { ok: true, data: { roundId: result.id, status: result.status } };
  },
  'INVESTOR.CLOSE_ROUND': async (actor, p) => {
    const result = await investorRound.closeRound(asInvestorActor(actor), need(p, 'id'), (p as never) ?? {});
    return { ok: true, data: { roundId: result.id, postMoney: result.postMoneyValuation } };
  },
  'INVESTOR.CONVERT_SAFES': async (actor, p) => {
    const result = await investorInvestment.convertOutstandingSafes(asInvestorActor(actor), need(p, 'roundId'));
    return { ok: true, data: { converted: result.converted, newInvestments: result.newInvestments } };
  },
  'INVESTOR.SET_VALUATION': async (actor, p) => {
    const result = await investorEntity.setValuation(asInvestorActor(actor), need(p, 'entityId'), p as never);
    return { ok: true, data: { entityId: result.id, valuation: result.currentValuation } };
  },
  'INVESTOR.CREATE_EXIT': async (actor, p) => {
    const result = await investorExit.createExit(asInvestorActor(actor), need(p, 'entityId'), p as never);
    return { ok: true, data: { exitId: result.id, status: result.status } };
  },
  'INVESTOR.EXECUTE_EXIT': async (actor, p) => {
    const result = await investorExit.executeExit(asInvestorActor(actor), need(p, 'exitId'));
    return { ok: true, data: { exitId: result.id, status: result.status } };
  },
  'INVESTOR.RECORD_DISTRIBUTION': async (actor, p) => {
    const result = await investorDistribution.recordDistribution(asInvestorActor(actor), p as never);
    return { ok: true, data: { distributionId: result.id, amount: result.amount } };
  },

  // ─ AI ──────────────────────────────────────────────────────────────────
  'AI.SCORE_INJURY_RISK': async (actor, p) => {
    const result = await playerDec.predictInjuryRisk(asAIActor(actor), need(p, 'playerId'));
    return { ok: true, data: { decisionId: result.id, score: result.score, urgency: result.urgency } };
  },
  'AI.SCORE_FRANCHISE_INVESTMENT': async (actor, p) => {
    const result = await franchiseDec.scoreFranchiseInvestmentOpportunity(asAIActor(actor), need(p, 'unitId'));
    return { ok: true, data: { decisionId: result.id, score: result.score, urgency: result.urgency } };
  },
  'AI.SCORE_TERRITORY_RISK': async (actor, p) => {
    const result = await franchiseDec.analyzeTerritoryRisk(asAIActor(actor), need(p, 'unitId'));
    return { ok: true, data: { decisionId: result.id, score: result.score, urgency: result.urgency } };
  },
  'AI.SCORE_REGIONAL_EXPANSION': async (actor, p) => {
    const result = await franchiseDec.recommendRegionalExpansion(asAIActor(actor), need(p, 'unitId'));
    return { ok: true, data: { decisionId: result.id, score: result.score, urgency: result.urgency } };
  },
  'AI.SCORE_ACQUISITION': async (actor, p) => {
    const result = await investorDec.recommendAcquisition(asAIActor(actor), need(p, 'entityId'));
    return { ok: true, data: { decisionId: result.id, score: result.score, urgency: result.urgency } };
  },
  'AI.SCORE_VALUATION': async (actor, p) => {
    const result = await investorDec.suggestValuation(asAIActor(actor), need(p, 'entityId'));
    return { ok: true, data: { decisionId: result.id, score: result.score, urgency: result.urgency } };
  },
  'AI.SCORE_FINANCIAL_HEALTH': async (actor, p) => {
    const result = await clubDec.predictFinancialHealth(asAIActor(actor), need(p, 'clubId'));
    return { ok: true, data: { decisionId: result.id, score: result.score, urgency: result.urgency } };
  },
  'AI.SCORE_SPONSORSHIP': async (actor, p) => {
    const result = await clubDec.recommendSponsorship(asAIActor(actor), need(p, 'clubId'));
    return { ok: true, data: { decisionId: result.id, score: result.score, urgency: result.urgency } };
  },
  'AI.REVIEW_DECISION': async (_actor, p) => {
    // Read-only acknowledgement step — surfaces the decision payload for human review.
    const decision = await prisma.aIDecision.findUnique({ where: { id: need(p, 'decisionId') } });
    if (!decision) return { ok: false, error: 'Decision not found' };
    return { ok: true, data: { decisionId: decision.id, status: decision.status, urgency: decision.urgency }, requiresHuman: true };
  },

  // ─ White-label ─────────────────────────────────────────────────────────
  'WHITELABEL.UPDATE_BRAND': async (actor, p) => {
    const result = await adminBranding.adminUpsertBranding(asPlatformActor(actor), need(p, 'clubId'), p as never);
    return { ok: true, data: { configId: result.id } };
  },
  'WHITELABEL.APPLY_PALETTE': async (actor, p) => {
    const result = await adminBranding.applyPaletteToClub(asPlatformActor(actor), need(p, 'clubId'), p as never);
    return { ok: true, data: { configId: result.config.id, paletteId: result.palette.id } };
  },

  // ─ Admin ───────────────────────────────────────────────────────────────
  'ADMIN.CREATE_SUBSCRIPTION_OVERRIDE': async (actor, p) => {
    const result = await adminOrganization.createOverride(asPlatformActor(actor), need(p, 'clubId'), p as never);
    return { ok: true, data: { overrideId: result.id, plan: result.plan, status: result.status } };
  },
  'ADMIN.REVOKE_SUBSCRIPTION_OVERRIDE': async (actor, p) => {
    const result = await adminOrganization.revokeOverride(asPlatformActor(actor), need(p, 'clubId'), need(p, 'overrideId'), p as never);
    return { ok: true, data: { overrideId: result.id } };
  },
  'ADMIN.UPDATE_LIMITS': async (actor, p) => {
    const result = await adminOrganization.updateLimits(asPlatformActor(actor), need(p, 'clubId'), p as never);
    return { ok: true, data: { limitsId: result.id } };
  },

  // ─ Executive internal ───────────────────────────────────────────────────
  'EXECUTIVE.OPEN_BOARD_RESOLUTION': async (_actor, p) => {
    // Resolved by executive-board.service.ts via the workflow service — the
    // executor records that this step has been dispatched, the board service
    // performs the actual creation when invoked separately.
    return { ok: true, data: { dispatched: true, resolutionParams: p } };
  },
  'EXECUTIVE.AWAIT_BOARD_RESOLUTION': async (_actor, p) => {
    const resolutionId = String(p.resolutionId ?? '');
    if (!resolutionId) return { ok: false, error: 'resolutionId required' };
    const resolution = await prisma.boardResolution.findUnique({ where: { id: resolutionId } });
    if (!resolution) return { ok: false, error: 'Resolution not found' };
    if (resolution.status === 'PASSED' || resolution.status === 'FAILED' || resolution.status === 'WITHDRAWN') {
      return { ok: true, data: { resolutionId, outcome: resolution.status } };
    }
    return { ok: true, data: { resolutionId, outcome: resolution.status }, requiresHuman: true };
  },
  'EXECUTIVE.SET_SPONSOR_STAGE': async (actor, p) => {
    const opportunityId = String(p.opportunityId ?? '');
    const stage = String(p.stage ?? '');
    if (!opportunityId || !stage) return { ok: false, error: 'opportunityId and stage required' };
    const existing = await prisma.sponsorOpportunity.findUnique({ where: { id: opportunityId } });
    if (!existing) return { ok: false, error: 'Sponsor opportunity not found' };
    if (existing.stage === stage) return { ok: true, data: { opportunityId, stage } };

    await prisma.$transaction([
      prisma.sponsorOpportunity.update({ where: { id: opportunityId }, data: { stage: stage as never } }),
      prisma.sponsorPipelineEvent.create({
        data: {
          opportunityId,
          fromStage: existing.stage,
          toStage: stage as never,
          changedBy: actor.userId,
        },
      }),
    ]);
    return { ok: true, data: { opportunityId, fromStage: existing.stage, toStage: stage } };
  },

  // ─ Custom (human-completed) ─────────────────────────────────────────────
  'CUSTOM.HUMAN_REVIEW': async (_actor, _p) => ({ ok: true, data: {}, requiresHuman: true }),
  'CUSTOM.NOOP': async () => ({ ok: true, data: {} }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────────────────────

export function isKnownAction(engine: string, action: string): boolean {
  const id = `${engine}.${action}` as StepActionId;
  return id in HANDLERS;
}

export function listKnownActions(): StepActionId[] {
  return Object.keys(HANDLERS) as StepActionId[];
}

export async function executeStep(
  actor: ExecutiveActor,
  engine: string,
  action: string,
  params: Record<string, unknown>,
): Promise<StepExecutionResult> {
  const id = `${engine}.${action}` as StepActionId;
  const handler = HANDLERS[id];
  if (!handler) {
    return { ok: false, error: `Unknown step action: ${id}` };
  }
  try {
    return await handler(actor, params);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
