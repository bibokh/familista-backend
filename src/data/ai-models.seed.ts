// Familista — AI Decision Engine
// File location: src/data/ai-models.seed.ts
//
// Idempotent seed of the 32 default RULE_BASED models — one per decision type.
// Each model is created in inactive state on first run; the bootstrap endpoint
// then activates the freshest version per (domain, decisionType). Subsequent
// runs upsert (no duplicates).
//
// After seeding, the engine is fully operational with deterministic scoring.
// To switch a decision type to a CLAUDE / HYBRID variant, register a new
// model version via `POST /api/v1/ai/models` and activate it.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type { AIDomain, AIDecisionType, AIModelProvider } from '@prisma/client';

type ModelSeed = {
  slug: string;
  name: string;
  domain: AIDomain;
  decisionType: AIDecisionType;
  version: string;
  provider: AIModelProvider;
  description: string;
  parameters: Record<string, unknown>;
};

const DEFAULT_VERSION = '1.0.0';

const SEEDS: ReadonlyArray<ModelSeed> = [
  // Player (7)
  { slug: 'player.injury-risk', name: 'Player Injury Risk', domain: 'PLAYER', decisionType: 'INJURY_RISK', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Composite injury-risk score from condition, recent injuries, load spike, age and GPS risk signals.',
    parameters: { conditionThreshold: 70, recentInjuryDays: 60, loadSpikeRatio: 0.2, ageRiskFloor: 30, gpsRiskFloor: 0.5 } },
  { slug: 'player.growth', name: 'Player Growth Analysis', domain: 'PLAYER', decisionType: 'PLAYER_GROWTH', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Trajectory score using potential gap, age curve, form and playing time.', parameters: { peakAge: 27, minPlayingTime: 180 } },
  { slug: 'player.talent', name: 'Talent Detection', domain: 'PLAYER', decisionType: 'TALENT_DETECTION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Peer-relative rating with age-window and output bonuses.', parameters: { youthCutoffAge: 23 } },
  { slug: 'player.fatigue', name: 'Fatigue Prediction', domain: 'PLAYER', decisionType: 'FATIGUE_PREDICTION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Condition drop, cumulative load and minutes load combined into a fatigue score.', parameters: { minutesFatigueThreshold: 540 } },
  { slug: 'player.transfer', name: 'Transfer Recommendation', domain: 'PLAYER', decisionType: 'TRANSFER_RECOMMENDATION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Contract runway, squad redundancy, age and wage pressure combined.', parameters: { contractRiskDays: 365, minMinutesForRole: 180, wagePressureThreshold: 30000 } },
  { slug: 'player.training', name: 'Training Optimization', domain: 'PLAYER', decisionType: 'TRAINING_OPTIMIZATION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Recommends drill mix based on condition, form, position and headroom.', parameters: {} },
  { slug: 'player.lineup', name: 'Lineup Recommendation', domain: 'PLAYER', decisionType: 'LINEUP_RECOMMENDATION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Greedy XI selection by rating subject to fitness and injuries.', parameters: {} },

  // Coach (6)
  { slug: 'coach.tactics', name: 'Tactical Recommendation', domain: 'COACH', decisionType: 'TACTICAL_RECOMMENDATION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Venue + form derived tactical approach.', parameters: {} },
  { slug: 'coach.formation', name: 'Formation Optimization', domain: 'COACH', decisionType: 'FORMATION_OPTIMIZATION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Selects canonical formation from squad position composition.', parameters: {} },
  { slug: 'coach.opponent', name: 'Opponent Analysis', domain: 'COACH', decisionType: 'OPPONENT_ANALYSIS', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Form, venue and rest factors combined into an opponent threat score.', parameters: {} },
  { slug: 'coach.prep', name: 'Match Preparation', domain: 'COACH', decisionType: 'MATCH_PREPARATION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Penalises injured / fatigued starters and short turnarounds.', parameters: {} },
  { slug: 'coach.subs', name: 'Substitution Recommendation', domain: 'COACH', decisionType: 'SUBSTITUTION_RECOMMENDATION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Surfaces fatigue-driven substitution candidates.', parameters: {} },
  { slug: 'coach.training-plan', name: 'Training Plan Generation', domain: 'COACH', decisionType: 'TRAINING_PLAN_GENERATION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Selects training drill mix from average squad condition.', parameters: {} },

  // Club (5)
  { slug: 'club.financial-health', name: 'Financial Health Prediction', domain: 'CLUB', decisionType: 'FINANCIAL_HEALTH_PREDICTION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Cash flow, revenue growth, subscription status and wage burden.', parameters: {} },
  { slug: 'club.budget', name: 'Budget Optimization', domain: 'CLUB', decisionType: 'BUDGET_OPTIMIZATION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Targets wage-to-revenue ratio and contract roll-off.', parameters: {} },
  { slug: 'club.salary-risk', name: 'Salary Risk Alert', domain: 'CLUB', decisionType: 'SALARY_RISK_ALERT', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Wage burden and runway combined into a salary risk score.', parameters: {} },
  { slug: 'club.sponsorship', name: 'Sponsorship Recommendation', domain: 'CLUB', decisionType: 'SPONSORSHIP_RECOMMENDATION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Sponsor-readiness from revenue, squad size and injury rate.', parameters: {} },
  { slug: 'club.transfer-market', name: 'Transfer Market Support', domain: 'CLUB', decisionType: 'TRANSFER_MARKET_SUPPORT', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Combines runway, injuries and contract churn into transfer activity score.', parameters: {} },

  // Franchise (5)
  { slug: 'franchise.expansion', name: 'Regional Expansion Recommendation', domain: 'FRANCHISE', decisionType: 'REGIONAL_EXPANSION_RECOMMENDATION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Combines growth, compliance and violations into expansion readiness.', parameters: {} },
  { slug: 'franchise.academy-profit', name: 'Academy Profitability Prediction', domain: 'FRANCHISE', decisionType: 'ACADEMY_PROFITABILITY_PREDICTION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Growth and compliance proxy for academy profitability.', parameters: {} },
  { slug: 'franchise.territory-risk', name: 'Territory Risk Analysis', domain: 'FRANCHISE', decisionType: 'TERRITORY_RISK_ANALYSIS', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Violations, compliance and contract roll-off form a risk score.', parameters: {} },
  { slug: 'franchise.operator-perf', name: 'Operator Performance Scoring', domain: 'FRANCHISE', decisionType: 'OPERATOR_PERFORMANCE_SCORING', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Growth, violations, compliance and club activation rate.', parameters: {} },
  { slug: 'franchise.investment-score', name: 'Franchise Investment Scoring', domain: 'FRANCHISE', decisionType: 'FRANCHISE_INVESTMENT_SCORING', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Investment attractiveness score for a franchise unit.', parameters: {} },

  // Investor (5)
  { slug: 'investor.roi', name: 'Investor ROI Prediction', domain: 'INVESTOR', decisionType: 'INVESTOR_ROI_PREDICTION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Multiple + IRR composite ROI score.', parameters: {} },
  { slug: 'investor.risk', name: 'Investment Risk Scoring', domain: 'INVESTOR', decisionType: 'INVESTMENT_RISK_SCORING', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Concentration, KYC and performance risk.', parameters: {} },
  { slug: 'investor.valuation', name: 'Valuation Engine', domain: 'INVESTOR', decisionType: 'VALUATION_ENGINE', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Revenue-multiple valuation suggestion with growth adjustment.', parameters: {} },
  { slug: 'investor.allocation', name: 'Capital Allocation Optimization', domain: 'INVESTOR', decisionType: 'CAPITAL_ALLOCATION_OPTIMIZATION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Diversification + capital-idle signal.', parameters: {} },
  { slug: 'investor.acquisition', name: 'Acquisition Recommendation', domain: 'INVESTOR', decisionType: 'ACQUISITION_RECOMMENDATION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Growth + value-per-revenue acquisition score.', parameters: {} },

  // Executive (5)
  { slug: 'executive.ceo-brief', name: 'CEO Dashboard Recommendation', domain: 'EXECUTIVE', decisionType: 'CEO_DASHBOARD_RECOMMENDATION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Platform growth and critical violations roll-up.', parameters: {} },
  { slug: 'executive.board-strategy', name: 'Board Strategic Suggestion', domain: 'EXECUTIVE', decisionType: 'BOARD_STRATEGIC_SUGGESTION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Growth + footprint + AUM strategic posture.', parameters: {} },
  { slug: 'executive.expansion-rank', name: 'Expansion Opportunity Ranker', domain: 'EXECUTIVE', decisionType: 'EXPANSION_OPPORTUNITY', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Wraps franchise expansion-opportunity ranker.', parameters: {} },
  { slug: 'executive.market-entry', name: 'Market Entry Prediction', domain: 'EXECUTIVE', decisionType: 'MARKET_ENTRY_PREDICTION', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Composite signal for new-region entry timing.', parameters: {} },
  { slug: 'executive.acquisition-target', name: 'Acquisition Target Evaluation', domain: 'EXECUTIVE', decisionType: 'ACQUISITION_TARGET', version: DEFAULT_VERSION, provider: 'HYBRID',
    description: 'Evaluates an external InvestmentEntity as an acquisition target.', parameters: {} },
];

const SHARED_INPUT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  description: 'Feature payload — shape depends on decisionType. See ai-engine.types.ts.',
  additionalProperties: true,
};

const SHARED_OUTPUT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['score', 'confidence', 'urgency', 'recommendation', 'evidence', 'rationale'],
  properties: {
    score: { type: 'number', minimum: 0, maximum: 100 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    urgency: { type: 'string', enum: ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    recommendation: { type: 'object' },
    evidence: { type: 'array' },
    rationale: { type: 'string' },
    alternatives: { type: 'array' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

export async function seedDefaultAIModels(actorUserId?: string): Promise<{ created: number; updated: number; activated: number }> {
  let created = 0;
  let updated = 0;
  let activated = 0;

  for (const seed of SEEDS) {
    const existing = await prisma.aIModel.findUnique({
      where: { slug_version: { slug: seed.slug, version: seed.version } },
    });

    if (existing) {
      await prisma.aIModel.update({
        where: { id: existing.id },
        data: {
          name: seed.name,
          description: seed.description,
          parameters: seed.parameters as Prisma.InputJsonValue,
        },
      });
      updated++;
    } else {
      await prisma.aIModel.create({
        data: {
          slug: seed.slug,
          name: seed.name,
          domain: seed.domain,
          decisionType: seed.decisionType,
          version: seed.version,
          provider: seed.provider,
          description: seed.description,
          inputSchema: SHARED_INPUT_SCHEMA as Prisma.InputJsonValue,
          outputSchema: SHARED_OUTPUT_SCHEMA as Prisma.InputJsonValue,
          parameters: seed.parameters as Prisma.InputJsonValue,
          isActive: false,
          createdBy: actorUserId ?? null,
        },
      });
      created++;
    }

    // Ensure there is exactly one active model per (domain, decisionType)
    const anyActive = await prisma.aIModel.findFirst({
      where: { domain: seed.domain, decisionType: seed.decisionType, isActive: true, deprecatedAt: null },
    });
    if (!anyActive) {
      const fresh = await prisma.aIModel.findUnique({
        where: { slug_version: { slug: seed.slug, version: seed.version } },
      });
      if (fresh) {
        await prisma.aIModel.update({
          where: { id: fresh.id },
          data: { isActive: true, releasedAt: new Date() },
        });
        activated++;
      }
    }
  }

  return { created, updated, activated };
}
