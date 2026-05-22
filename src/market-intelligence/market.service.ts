// Familista — Autonomous Market Intelligence (Phase N)
// ─────────────────────────────────────────────────────────────────────────
// 3 deterministic predictors (n1). Each row is audit-anchored. Composes
// with (does not replace) Phase M PlayerAssetValue + ContractRisk.

import { AcademyDevelopmentForecast, ContractIntelligenceSnapshot, MarketTransferPrediction, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface MarketActor {
  userId: string;
  clubId: string;
  role?:  string;
}

const VERSION = 'n1';

// ── Market transfer prediction ──────────────────────────────────────────

export interface MarketTransferInput {
  positionScarcity:   number;     // 0..1
  ageBracket:         'YOUTH' | 'PRIME' | 'VETERAN';
  contractMonthsLeft: number;     // months
  performanceTrend:   number;     // -1..1
  agentNetworkSignal: number;     // 0..1
}

export function computeMarketTransferProbability(i: MarketTransferInput): { probability: number; expectedFeeCents: bigint; components: Record<string, number | string> } {
  const cShort = Math.max(0, Math.min(1, 1 - i.contractMonthsLeft / 24));
  const ageMul = i.ageBracket === 'PRIME' ? 1.0 : i.ageBracket === 'YOUTH' ? 0.85 : 0.6;
  const trendNorm = (i.performanceTrend + 1) / 2;                              // -1..1 → 0..1
  const p = Math.max(0, Math.min(1,
      0.35 * cShort
    + 0.20 * Math.max(0, Math.min(1, i.positionScarcity))
    + 0.15 * Math.max(0, Math.min(1, i.agentNetworkSignal))
    + 0.15 * trendNorm
    + 0.15 * (ageMul - 0.6),                                                   // PRIME contributes more
  ));
  const baseFeeEUR = 800_000;
  const feeMultiplier = (1 + i.positionScarcity * 2) * (1 + (trendNorm - 0.5)) * (ageMul + 0.3);
  const expectedFeeEUR = Math.max(0, Math.round(baseFeeEUR * feeMultiplier));
  return {
    probability: Number(p.toFixed(3)),
    expectedFeeCents: BigInt(expectedFeeEUR * 100),
    components: { cShort, ageMul, trendNorm, ...i },
  };
}

export interface PersistMarketTransferDto {
  athleteIdHash?: string;
  fromClubRef?:   string;
  toClubRef?:     string;
  horizonDays?:   number;
  input:          MarketTransferInput;
}

export async function persistMarketTransferPrediction(actor: MarketActor, dto: PersistMarketTransferDto): Promise<MarketTransferPrediction> {
  const out = computeMarketTransferProbability(dto.input);
  const row = await prisma.marketTransferPrediction.create({
    data: {
      clubId:        actor.clubId,
      athleteIdHash: dto.athleteIdHash ?? null,
      fromClubRef:   dto.fromClubRef ?? null,
      toClubRef:     dto.toClubRef ?? null,
      probability:   out.probability,
      expectedFeeCents: out.expectedFeeCents,
      horizonDays:   dto.horizonDays ?? 180,
      components:    out.components as unknown as Prisma.InputJsonValue,
      modelVersion:  VERSION,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'MARKET_TRANSFER_PREDICTED',
    entityType: 'MarketTransferPrediction', entityId: row.id,
    payload: { probability: out.probability, expectedFeeCents: out.expectedFeeCents.toString(), horizonDays: row.horizonDays },
  });
  return row;
}

// ── Contract intelligence ──────────────────────────────────────────────

export interface ContractIntelInput {
  monthsLeft:        number;
  renewalSatisfaction: number;   // 0..1
  externalOffers:    number;
  bosmanRisk:        number;     // 0..1
}

export function classifyContractIntel(i: ContractIntelInput): { signal: string; components: Record<string, number> } {
  if (i.monthsLeft <= 6 && i.bosmanRisk > 0.6) return { signal: 'BOSMAN_RISK', components: { ...i } };
  if (i.monthsLeft <= 12)                       return { signal: 'EXPIRY_SOON', components: { ...i } };
  if (i.renewalSatisfaction > 0.7)              return { signal: 'RENEWAL_LIKELY', components: { ...i } };
  if (i.externalOffers >= 2)                    return { signal: 'TRANSFER_CANDIDATE', components: { ...i } };
  return { signal: 'STABLE', components: { ...i } };
}

export async function recordContractIntelligence(actor: MarketActor, dto: { athleteIdHash?: string; input: ContractIntelInput; payload?: Prisma.InputJsonValue }): Promise<ContractIntelligenceSnapshot> {
  const out = classifyContractIntel(dto.input);
  return prisma.contractIntelligenceSnapshot.create({
    data: {
      clubId:        actor.clubId,
      athleteIdHash: dto.athleteIdHash ?? null,
      signal:        out.signal,
      payload:       (dto.payload ?? out.components) as Prisma.InputJsonValue,
      modelVersion:  VERSION,
    },
  });
}

// ── Academy development forecast ────────────────────────────────────────

export interface AcademyForecastInput {
  squadSize:          number;
  avgTalentProjection: number;   // projected OVR
  historicalROI:      number;    // 0..∞
  pipelineStrength:   number;    // 0..1
}

export function computeAcademyForecast(i: AcademyForecastInput, horizonYears = 5): { projectedValueCents: bigint; components: Record<string, number> } {
  const baselineEUR = 500_000;
  const valueMul =
      Math.max(0.5, 1 + (i.avgTalentProjection - 70) * 0.05)
    * Math.max(0.5, 1 + i.historicalROI * 0.15)
    * (0.6 + i.pipelineStrength * 0.8);
  const expectedValueEUR = Math.max(0, Math.round(baselineEUR * i.squadSize * valueMul * (horizonYears / 5)));
  return { projectedValueCents: BigInt(expectedValueEUR * 100), components: { valueMul, ...i, horizonYears } };
}

export async function recordAcademyForecast(actor: MarketActor, dto: { academyName: string; horizonYears?: number; input: AcademyForecastInput }): Promise<AcademyDevelopmentForecast> {
  if (!dto.academyName) throw new BadRequestError('academyName required');
  const out = computeAcademyForecast(dto.input, dto.horizonYears ?? 5);
  return prisma.academyDevelopmentForecast.create({
    data: {
      clubId:              actor.clubId,
      academyName:         dto.academyName,
      horizonYears:        dto.horizonYears ?? 5,
      projectedValueCents: out.projectedValueCents,
      components:          out.components as unknown as Prisma.InputJsonValue,
      modelVersion:        VERSION,
    },
  });
}
