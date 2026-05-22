// Familista — Global Scouting Intelligence (Phase N)
// ─────────────────────────────────────────────────────────────────────────
// Worldwide scouting nodes + discovery pipeline + cross-club ranking +
// confidence scoring + replay-safe evaluation. All audit-anchored.

import { ConfidenceScore, DiscoveryStatus, GlobalRecommendationRanking, Prisma, ScoutingEvaluation, WorldwideScoutingNode } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { signRecommendation } from '../security-n/signed-recommendations.service';

export interface ScoutingActor {
  userId: string;
  clubId: string;
  role?:  string;
}

const VERSION = 'n1';

// ── WorldwideScoutingNode ───────────────────────────────────────────────

export interface RegisterNodeDto {
  label:        string;
  regionCode?:  string;
  countryCodes?: Prisma.InputJsonValue;
  specialities?: Prisma.InputJsonValue;
  global?:      boolean;
}

export async function registerNode(actor: ScoutingActor, dto: RegisterNodeDto): Promise<WorldwideScoutingNode> {
  if (!dto.label) throw new BadRequestError('label required');
  if (dto.global && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError('Only SUPER_ADMIN may publish global node');
  return prisma.worldwideScoutingNode.create({
    data: {
      clubId:       dto.global ? null : actor.clubId,
      label:        dto.label,
      regionCode:   dto.regionCode ?? null,
      countryCodes: (dto.countryCodes ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      specialities: (dto.specialities ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

export async function listNodes(actor: ScoutingActor, opts: { regionCode?: string; includeGlobal?: boolean } = {}): Promise<WorldwideScoutingNode[]> {
  return prisma.worldwideScoutingNode.findMany({
    where: {
      isActive: true,
      OR: [
        { clubId: actor.clubId },
        ...(opts.includeGlobal === false ? [] : [{ clubId: null }]),
      ],
      ...(opts.regionCode ? { regionCode: opts.regionCode } : {}),
    },
    orderBy: { publishedAt: 'desc' },
    take: 200,
  });
}

// ── Talent discovery ───────────────────────────────────────────────────

export interface DiscoveryDto {
  scoutingNodeId?: string;
  athleteIdHash?:  string;
  externalRef?:    string;
  prospectName:    string;
  position?:       string;
  age?:            number;
  region?:         string;
  status?:         DiscoveryStatus;
  payload:         Prisma.InputJsonValue;
}

export async function recordDiscovery(actor: ScoutingActor, dto: DiscoveryDto): Promise<TalentDiscoveryEventReturn> {
  if (!dto.prospectName || dto.payload === undefined) throw new BadRequestError('prospectName + payload required');
  const row = await prisma.talentDiscoveryEvent.create({
    data: {
      clubId:        actor.clubId,
      scoutingNodeId: dto.scoutingNodeId ?? null,
      athleteIdHash:  dto.athleteIdHash ?? null,
      externalRef:   dto.externalRef ?? null,
      prospectName:  dto.prospectName,
      position:      dto.position ?? null,
      age:           dto.age ?? null,
      region:        dto.region ?? null,
      status:        dto.status ?? 'PROSPECT',
      payload:       dto.payload,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'TALENT_DISCOVERED',
    entityType: 'TalentDiscoveryEvent', entityId: row.id,
    payload: { prospectName: dto.prospectName, position: dto.position, status: row.status },
  });
  return row;
}

type TalentDiscoveryEventReturn = Awaited<ReturnType<typeof prisma.talentDiscoveryEvent.create>>;

export async function listDiscoveries(actor: ScoutingActor, opts: { status?: DiscoveryStatus; limit?: number } = {}): Promise<TalentDiscoveryEventReturn[]> {
  return prisma.talentDiscoveryEvent.findMany({
    where: { clubId: actor.clubId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 100, 1000),
  });
}

export async function updateDiscoveryStatus(actor: ScoutingActor, id: string, status: DiscoveryStatus): Promise<TalentDiscoveryEventReturn> {
  const d = await prisma.talentDiscoveryEvent.findUnique({ where: { id } });
  if (!d)                                                                                  throw new NotFoundError('TalentDiscoveryEvent');
  if (d.clubId && d.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')               throw new ForbiddenError();
  return prisma.talentDiscoveryEvent.update({ where: { id }, data: { status } });
}

// ── Global recommendation ranking (HMAC-signed) ─────────────────────────

export interface RankingInput {
  scoutScore:      number;       // 0..100
  marketScarcity:  number;       // 0..1
  positionalNeed:  number;       // 0..1
  financialFit:    number;       // 0..1
  developmentFit:  number;       // 0..1
}

export function computeRanking(i: RankingInput): { score: number; components: Record<string, number> } {
  const s = Math.max(0, Math.min(1,
      0.30 * (i.scoutScore / 100)
    + 0.20 * i.marketScarcity
    + 0.20 * i.positionalNeed
    + 0.15 * i.financialFit
    + 0.15 * i.developmentFit,
  ));
  return { score: Number(s.toFixed(3)), components: { ...i } };
}

export interface RecordRankingDto {
  discoveryId?:    string;
  athleteIdHash?:  string;
  position?:       string;
  input:           RankingInput;
}

export async function recordRanking(actor: ScoutingActor, dto: RecordRankingDto): Promise<GlobalRecommendationRanking> {
  const out = computeRanking(dto.input);
  const row = await prisma.globalRecommendationRanking.create({
    data: {
      clubId:       actor.clubId,
      discoveryId:  dto.discoveryId ?? null,
      athleteIdHash: dto.athleteIdHash ?? null,
      position:     dto.position ?? null,
      score:        out.score,
      components:   out.components as unknown as Prisma.InputJsonValue,
      modelVersion: VERSION,
    },
  });
  // Sign + persist the signature.
  await signRecommendation(actor.clubId, row.id, 'GLOBAL_RANKING', { clubId: actor.clubId, score: row.score, components: out.components, discoveryId: row.discoveryId, athleteIdHash: row.athleteIdHash });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'GLOBAL_RANKING_PUBLISHED',
    entityType: 'GlobalRecommendationRanking', entityId: row.id,
    payload: { score: row.score, discoveryId: row.discoveryId },
  });
  return row;
}

export async function listRankings(actor: ScoutingActor, opts: { position?: string; limit?: number } = {}): Promise<GlobalRecommendationRanking[]> {
  return prisma.globalRecommendationRanking.findMany({
    where: { clubId: actor.clubId, ...(opts.position ? { position: opts.position } : {}) },
    orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(opts.limit ?? 50, 500),
  });
}

// ── Confidence scoring (per source) ────────────────────────────────────

export async function recordConfidence(actor: ScoutingActor, dto: { sourceKind: string; sourceRef: string; score: number; components?: Prisma.InputJsonValue }): Promise<ConfidenceScore> {
  if (!dto.sourceKind || !dto.sourceRef) throw new BadRequestError('sourceKind + sourceRef required');
  return prisma.confidenceScore.create({
    data: {
      clubId:       actor.clubId,
      sourceKind:   dto.sourceKind,
      sourceRef:    dto.sourceRef,
      score:        Math.max(0, Math.min(1, dto.score)),
      components:   (dto.components ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      modelVersion: VERSION,
    },
  });
}

// ── Scouting evaluation (replay-safe) ──────────────────────────────────

export async function recordEvaluation(actor: ScoutingActor, dto: { discoveryId?: string; athleteIdHash?: string; payload: Prisma.InputJsonValue; score?: number }): Promise<ScoutingEvaluation> {
  return prisma.scoutingEvaluation.create({
    data: {
      clubId:        actor.clubId,
      discoveryId:   dto.discoveryId ?? null,
      athleteIdHash: dto.athleteIdHash ?? null,
      evaluatorId:   actor.userId,
      payload:       dto.payload,
      score:         Math.max(0, Math.min(1, dto.score ?? 0)),
      modelVersion:  VERSION,
    },
  });
}

export async function listEvaluations(actor: ScoutingActor, opts: { discoveryId?: string; limit?: number } = {}): Promise<ScoutingEvaluation[]> {
  return prisma.scoutingEvaluation.findMany({
    where: { clubId: actor.clubId, ...(opts.discoveryId ? { discoveryId: opts.discoveryId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 100, 1000),
  });
}
