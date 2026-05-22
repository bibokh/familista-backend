// Familista — Performance Economics (Phase M)
// ─────────────────────────────────────────────────────────────────────────
// 5 economic metric writers + pure-function estimators. All carry
// `modelVersion = "m1"`. Append-only.

import { AcademyROI, CommercialScore, ContractRisk, PlayerAssetValue, Prisma, SponsorImpact } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError } from '../utils/errors';

export interface EconActor {
  userId: string;
  clubId: string;
  role?:  string;
}

const VERSION = 'm1';

// ── PlayerAssetValue ────────────────────────────────────────────────────

export interface AssetValueInput {
  age:             number;
  ovr:             number;
  contractMonths:  number;
  marketDemand:    number;        // 0..1
  injuryRisk:      number;        // 0..1
}

/** Pure-function asset valuation (cents). */
export function computeAssetValue(i: AssetValueInput): { valueCents: number; components: Record<string, number>; version: string } {
  const ovrFactor   = Math.pow(i.ovr / 70, 2.4);
  const ageDecay    = i.age <= 26 ? 1 : Math.max(0.3, 1 - (i.age - 26) * 0.07);
  const contractMul = Math.max(0.3, Math.min(1.5, i.contractMonths / 36));
  const demand      = 0.5 + i.marketDemand;
  const risk        = 1 - i.injuryRisk * 0.6;
  const valueEUR    = 1_000_000 * ovrFactor * ageDecay * contractMul * demand * risk;
  return { valueCents: Math.max(0, Math.round(valueEUR * 100)), components: { ovrFactor, ageDecay, contractMul, demand, risk, ...i }, version: VERSION };
}

export async function persistAssetValue(actor: EconActor, playerId: string, input: AssetValueInput): Promise<PlayerAssetValue> {
  if (!playerId) throw new BadRequestError('playerId required');
  const out = computeAssetValue(input);
  return prisma.playerAssetValue.create({
    data: {
      clubId:       actor.clubId,
      playerId,
      valueCents:   out.valueCents,
      components:   out.components as unknown as Prisma.InputJsonValue,
      modelVersion: out.version,
    },
  });
}

// ── ContractRisk ────────────────────────────────────────────────────────

export interface ContractRiskInput {
  monthsRemaining:    number;
  satisfaction:       number;
  alternativeOffers:  number;
  ageBucket:          'YOUTH' | 'PRIME' | 'VETERAN';
}

export function computeContractRisk(i: ContractRiskInput): { riskScore: number; components: Record<string, number | string>; version: string } {
  const expiryRisk     = Math.max(0, Math.min(1, 1 - i.monthsRemaining / 24));
  const satisfactionR  = Math.max(0, Math.min(1, 1 - i.satisfaction));
  const interestR      = Math.max(0, Math.min(1, i.alternativeOffers / 5));
  const ageMul         = i.ageBucket === 'PRIME' ? 1.0 : i.ageBucket === 'YOUTH' ? 0.7 : 0.85;
  const score          = Math.max(0, Math.min(1, (0.4 * expiryRisk + 0.3 * satisfactionR + 0.3 * interestR) * ageMul));
  return { riskScore: Number(score.toFixed(3)), components: { expiryRisk, satisfactionR, interestR, ageMul, ageBucket: i.ageBucket }, version: VERSION };
}

export async function persistContractRisk(actor: EconActor, playerId: string, input: ContractRiskInput, expiryDate?: string): Promise<ContractRisk> {
  const out = computeContractRisk(input);
  return prisma.contractRisk.create({
    data: {
      clubId:       actor.clubId,
      playerId,
      riskScore:    out.riskScore,
      expiryDate:   expiryDate ? new Date(expiryDate) : null,
      components:   out.components as unknown as Prisma.InputJsonValue,
      modelVersion: out.version,
    },
  });
}

// ── SponsorImpact ───────────────────────────────────────────────────────

export async function recordSponsorImpact(actor: EconActor, dto: { sponsorName?: string; channelKind: string; valueCents: number; components: Prisma.InputJsonValue }): Promise<SponsorImpact> {
  if (!dto.channelKind) throw new BadRequestError('channelKind required');
  return prisma.sponsorImpact.create({
    data: {
      clubId:      actor.clubId,
      sponsorName: dto.sponsorName ?? null,
      channelKind: dto.channelKind,
      valueCents:  Math.max(0, dto.valueCents | 0),
      components:  dto.components,
    },
  });
}

// ── CommercialScore ─────────────────────────────────────────────────────

export async function recordCommercialScore(actor: EconActor, dto: { scope: 'CLUB' | 'TEAM' | 'PLAYER'; refId?: string; score: number; components: Prisma.InputJsonValue }): Promise<CommercialScore> {
  return prisma.commercialScore.create({
    data: {
      clubId:     actor.clubId,
      scope:      dto.scope,
      refId:      dto.refId ?? null,
      score:      Math.max(0, Math.min(1, dto.score)),
      components: dto.components,
    },
  });
}

// ── AcademyROI ──────────────────────────────────────────────────────────

export async function recordAcademyROI(actor: EconActor, dto: { academyName: string; season: string; investmentCents: number; valueCreatedCents: number; components: Prisma.InputJsonValue }): Promise<AcademyROI> {
  if (!dto.academyName || !dto.season) throw new BadRequestError('academyName + season required');
  const roi = dto.investmentCents === 0 ? 0 : (dto.valueCreatedCents - dto.investmentCents) / dto.investmentCents;
  return prisma.academyROI.upsert({
    where:  { clubId_academyName_season: { clubId: actor.clubId, academyName: dto.academyName, season: dto.season } },
    create: {
      clubId:            actor.clubId,
      academyName:       dto.academyName,
      season:            dto.season,
      investmentCents:   Math.max(0, dto.investmentCents | 0),
      valueCreatedCents: Math.max(0, dto.valueCreatedCents | 0),
      roi:               Number(roi.toFixed(3)),
      components:        dto.components,
    },
    update: {
      investmentCents:   Math.max(0, dto.investmentCents | 0),
      valueCreatedCents: Math.max(0, dto.valueCreatedCents | 0),
      roi:               Number(roi.toFixed(3)),
      components:        dto.components,
    },
  });
}
