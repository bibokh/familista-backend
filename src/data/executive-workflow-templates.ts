// Familista — Executive OS · Integration Layer
// File location: src/data/executive-workflow-templates.ts
//
// Canonical workflow templates. Each template lays out:
//   • The required attestation roles before execution can proceed.
//   • The ordered list of cross-engine steps the executor will run.
//
// New workflow kinds are added here, not in service code — templates are
// declarative data. The step executor (executive-step-executor.service.ts)
// resolves (engine, action) tuples against its handler registry.

import type { WorkflowTemplate } from '../types/executive.types';

export const WORKFLOW_TEMPLATES: ReadonlyArray<WorkflowTemplate> = [
  // ─── Sponsor onboarding ───────────────────────────────────────────────────
  {
    slug: 'sponsor.onboarding.v1',
    kind: 'SPONSOR_ONBOARDING',
    title: 'Sponsor onboarding',
    description:
      'Qualify a sponsor opportunity, score the recommendation against the club, attestation by CEO/CFO, ' +
      'progress the pipeline through signature → active.',
    requiredAttestations: ['CEO', 'CFO'],
    defaultPriority: 'NORMAL',
    defaultDueInDays: 30,
    steps: [
      {
        order: 1,
        name: 'Score sponsorship recommendation',
        description: 'Run the AI Sponsorship model against the target club.',
        engine: 'AI',
        action: 'AI.SCORE_SPONSORSHIP',
        paramsSchema: { clubId: 'string' },
      },
      {
        order: 2,
        name: 'Move sponsor to QUALIFIED',
        engine: 'EXECUTIVE',
        action: 'EXECUTIVE.SET_SPONSOR_STAGE',
        paramsSchema: { opportunityId: 'string', stage: 'QUALIFIED' },
      },
      {
        order: 3,
        name: 'Send proposal (human)',
        description: 'Counsel-reviewed proposal sent to sponsor.',
        engine: 'CUSTOM',
        action: 'CUSTOM.HUMAN_REVIEW',
        paramsSchema: { checklist: 'array' },
        requiresHuman: true,
      },
      {
        order: 4,
        name: 'Move sponsor to PROPOSAL_SENT',
        engine: 'EXECUTIVE',
        action: 'EXECUTIVE.SET_SPONSOR_STAGE',
        paramsSchema: { opportunityId: 'string', stage: 'PROPOSAL_SENT' },
      },
      {
        order: 5,
        name: 'Contract signature (human)',
        description: 'Counsel + CFO confirm signature.',
        engine: 'CUSTOM',
        action: 'CUSTOM.HUMAN_REVIEW',
        paramsSchema: { signatureRef: 'string' },
        requiresHuman: true,
      },
      {
        order: 6,
        name: 'Activate sponsor',
        engine: 'EXECUTIVE',
        action: 'EXECUTIVE.SET_SPONSOR_STAGE',
        paramsSchema: { opportunityId: 'string', stage: 'ACTIVE' },
      },
    ],
  },

  // ─── Acquisition ──────────────────────────────────────────────────────────
  {
    slug: 'acquisition.standard.v1',
    kind: 'ACQUISITION',
    title: 'Acquisition workflow',
    description:
      'Score the acquisition target, raise an acquisition request, board attestation, decide + execute.',
    requiredAttestations: ['CEO', 'CFO', 'INVESTOR_LEAD'],
    defaultPriority: 'HIGH',
    defaultDueInDays: 60,
    steps: [
      {
        order: 1,
        name: 'Score acquisition target',
        engine: 'AI',
        action: 'AI.SCORE_ACQUISITION',
        paramsSchema: { entityId: 'string' },
      },
      {
        order: 2,
        name: 'Create investor acquisition request',
        engine: 'INVESTOR',
        action: 'INVESTOR.CREATE_INVESTMENT',
        paramsSchema: {
          investorId: 'string',
          entityId: 'string',
          instrumentType: 'EQUITY',
          committedAmount: 'number',
          shareClassId: 'string',
          sharesIssued: 'number',
          pricePerShare: 'number',
        },
      },
      {
        order: 3,
        name: 'Due diligence (human)',
        engine: 'CUSTOM',
        action: 'CUSTOM.HUMAN_REVIEW',
        paramsSchema: { dueDiligenceUrl: 'string' },
        requiresHuman: true,
      },
      {
        order: 4,
        name: 'Fund the investment',
        engine: 'INVESTOR',
        action: 'INVESTOR.FUND_INVESTMENT',
        paramsSchema: { investmentId: 'string', amount: 'number' },
      },
    ],
  },

  // ─── Territory expansion ──────────────────────────────────────────────────
  {
    slug: 'expansion.territory.v1',
    kind: 'TERRITORY_EXPANSION',
    title: 'Territory expansion',
    description:
      'Score regional expansion, raise franchise expansion request, attestation, decide, complete (creates unit).',
    requiredAttestations: ['CEO', 'COO'],
    defaultPriority: 'HIGH',
    defaultDueInDays: 90,
    steps: [
      {
        order: 1,
        name: 'Score regional expansion',
        engine: 'AI',
        action: 'AI.SCORE_REGIONAL_EXPANSION',
        paramsSchema: { unitId: 'string' },
      },
      {
        order: 2,
        name: 'Create expansion request',
        engine: 'FRANCHISE',
        action: 'FRANCHISE.CREATE_EXPANSION_REQUEST',
        paramsSchema: {
          requestingUnitId: 'string',
          targetTerritoryId: 'string',
          targetLevel: 'string',
          proposedName: 'string',
          proposedCode: 'string',
        },
      },
      {
        order: 3,
        name: 'Operator decision',
        engine: 'FRANCHISE',
        action: 'FRANCHISE.DECIDE_EXPANSION_REQUEST',
        paramsSchema: { id: 'string', decision: 'string', notes: 'string' },
      },
      {
        order: 4,
        name: 'Complete expansion (create unit)',
        engine: 'FRANCHISE',
        action: 'FRANCHISE.COMPLETE_EXPANSION_REQUEST',
        paramsSchema: { id: 'string', unitCode: 'string', unitName: 'string' },
      },
    ],
  },

  // ─── Capital deployment ───────────────────────────────────────────────────
  {
    slug: 'capital.deployment.v1',
    kind: 'CAPITAL_DEPLOYMENT',
    title: 'Capital deployment round',
    description:
      'Open an investment round, set valuation, gather commitments via separate workflows, close, convert SAFEs.',
    requiredAttestations: ['CEO', 'CFO', 'CHAIR'],
    defaultPriority: 'HIGH',
    defaultDueInDays: 120,
    steps: [
      {
        order: 1,
        name: 'Score entity valuation',
        engine: 'AI',
        action: 'AI.SCORE_VALUATION',
        paramsSchema: { entityId: 'string' },
      },
      {
        order: 2,
        name: 'Create round',
        engine: 'INVESTOR',
        action: 'INVESTOR.CREATE_ROUND',
        paramsSchema: { entityId: 'string', type: 'string', name: 'string', targetRaise: 'number', preMoneyValuation: 'number' },
      },
      {
        order: 3,
        name: 'Open round',
        engine: 'INVESTOR',
        action: 'INVESTOR.OPEN_ROUND',
        paramsSchema: { id: 'string' },
      },
      {
        order: 4,
        name: 'Close round',
        engine: 'INVESTOR',
        action: 'INVESTOR.CLOSE_ROUND',
        paramsSchema: { id: 'string' },
        requiresHuman: true,
      },
      {
        order: 5,
        name: 'Convert outstanding SAFEs',
        engine: 'INVESTOR',
        action: 'INVESTOR.CONVERT_SAFES',
        paramsSchema: { roundId: 'string' },
      },
    ],
  },

  // ─── Risk intervention ────────────────────────────────────────────────────
  {
    slug: 'risk.intervention.v1',
    kind: 'RISK_INTERVENTION',
    title: 'Risk intervention',
    description:
      'Investigate a high-severity risk alert, apply mitigation (override / limit / contract action), close out.',
    requiredAttestations: ['CEO', 'COO'],
    defaultPriority: 'URGENT',
    defaultDueInDays: 14,
    steps: [
      {
        order: 1,
        name: 'Score financial health',
        engine: 'AI',
        action: 'AI.SCORE_FINANCIAL_HEALTH',
        paramsSchema: { clubId: 'string' },
      },
      {
        order: 2,
        name: 'Decide mitigation (human)',
        engine: 'CUSTOM',
        action: 'CUSTOM.HUMAN_REVIEW',
        paramsSchema: { mitigationPlan: 'string' },
        requiresHuman: true,
      },
      {
        order: 3,
        name: 'Apply subscription override (if required)',
        engine: 'ADMIN',
        action: 'ADMIN.CREATE_SUBSCRIPTION_OVERRIDE',
        paramsSchema: { clubId: 'string', plan: 'string', reason: 'string' },
      },
    ],
  },

  // ─── Governance action ────────────────────────────────────────────────────
  {
    slug: 'governance.resolution.v1',
    kind: 'GOVERNANCE_ACTION',
    title: 'Board governance action',
    description: 'Raise a board resolution, circulate, vote, record outcome.',
    requiredAttestations: ['CHAIR'],
    defaultPriority: 'HIGH',
    defaultDueInDays: 30,
    steps: [
      {
        order: 1,
        name: 'Open board resolution',
        engine: 'EXECUTIVE',
        action: 'EXECUTIVE.OPEN_BOARD_RESOLUTION',
        paramsSchema: { title: 'string', resolutionText: 'string', quorumRequired: 'number', passingMajority: 'number' },
      },
      {
        order: 2,
        name: 'Await board decision',
        engine: 'EXECUTIVE',
        action: 'EXECUTIVE.AWAIT_BOARD_RESOLUTION',
        paramsSchema: { resolutionId: 'string' },
        requiresHuman: true,
      },
    ],
  },
];

export function findTemplate(slug: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.slug === slug);
}
