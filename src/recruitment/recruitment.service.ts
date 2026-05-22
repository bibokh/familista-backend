// Familista — Autonomous Recruitment Engine (Phase M)
// ─────────────────────────────────────────────────────────────────────────
// Targets + scout reports + scoring + transfer probability + projection.
// Pure-function metric helpers (deterministic) sit alongside the writers.
// All scoring carries `modelVersion = "m1"`.

import { CareerProjectionGraph, PlayerSimilarityGraph, PlayerTarget, Prisma, RecruitmentScore, RecruitmentScoutReport, RecruitmentStatus, ScoutNetwork, TalentGraph, TalentProjection, TransferProbability } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface RecruitActor {
  userId: string;
  clubId: string;
  role?:  string;
}

const VERSION = 'm1';
const ACTIVE_TARGET_CAP = 50;

// ── PlayerTarget ────────────────────────────────────────────────────────

export interface CreateTargetDto {
  playerName:    string;
  externalRef?:  string;
  playerId?:     string;
  position?:     string;
  age?:          number;
  currentClub?:  string;
  marketValue?:  number;
  contractUntil?: string;
  status?:       RecruitmentStatus;
  priority?:     number;
  notes?:        string;
}

export async function createTarget(actor: RecruitActor, dto: CreateTargetDto): Promise<PlayerTarget> {
  if (!dto.playerName) throw new BadRequestError('playerName required');
  const active = await prisma.playerTarget.count({ where: { clubId: actor.clubId, status: { in: ['LEAD','SCOUTED','EVALUATED','TARGETED','OFFERED'] } } });
  if (active >= ACTIVE_TARGET_CAP) throw new BadRequestError(`Active target cap (${ACTIVE_TARGET_CAP}) reached`);
  const row = await prisma.playerTarget.create({
    data: {
      clubId:        actor.clubId,
      playerName:    dto.playerName,
      externalRef:   dto.externalRef ?? null,
      playerId:      dto.playerId ?? null,
      position:      dto.position ?? null,
      age:           dto.age ?? null,
      currentClub:   dto.currentClub ?? null,
      marketValue:   dto.marketValue ?? null,
      contractUntil: dto.contractUntil ? new Date(dto.contractUntil) : null,
      status:        dto.status ?? 'LEAD',
      priority:      Math.max(0, Math.min(100, dto.priority ?? 50)),
      notes:         dto.notes ?? null,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'RECRUITMENT_TARGET_CREATED', entityType: 'PlayerTarget', entityId: row.id,
    payload: { playerName: dto.playerName, position: dto.position },
  });
  return row;
}

export async function listTargets(actor: RecruitActor, opts: { status?: RecruitmentStatus; position?: string; page?: number; limit?: number } = {}) {
  const { page = 1, limit = 50 } = opts;
  const where: Prisma.PlayerTargetWhereInput = {
    clubId: actor.clubId,
    ...(opts.status   ? { status: opts.status } : {}),
    ...(opts.position ? { position: opts.position } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.playerTarget.findMany({ where, orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: Math.min(limit, 200) }),
    prisma.playerTarget.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function updateTargetStatus(actor: RecruitActor, id: string, status: RecruitmentStatus): Promise<PlayerTarget> {
  const t = await prisma.playerTarget.findUnique({ where: { id } });
  if (!t)                                                       throw new NotFoundError('PlayerTarget');
  if (t.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.playerTarget.update({ where: { id }, data: { status } });
}

// ── ScoutReport ─────────────────────────────────────────────────────────

export interface CreateScoutReportDto {
  playerTargetId?: string;
  playerId?:       string;
  reportKind:      string;
  payload:         Prisma.InputJsonValue;
  score?:          number;
  notes?:          string;
}

export async function createScoutReport(actor: RecruitActor, dto: CreateScoutReportDto): Promise<RecruitmentScoutReport> {
  if (!dto.reportKind || dto.payload === undefined) throw new BadRequestError('reportKind + payload required');
  return prisma.recruitmentScoutReport.create({
    data: {
      clubId:         actor.clubId,
      playerTargetId: dto.playerTargetId ?? null,
      playerId:       dto.playerId ?? null,
      scoutUserId:    actor.userId,
      reportKind:     dto.reportKind,
      payload:        dto.payload,
      score:          Math.max(0, Math.min(100, dto.score ?? 0)),
      notes:          dto.notes ?? null,
    },
  });
}

export async function listScoutReports(actor: RecruitActor, opts: { playerTargetId?: string; playerId?: string; limit?: number } = {}): Promise<RecruitmentScoutReport[]> {
  return prisma.recruitmentScoutReport.findMany({
    where: {
      clubId: actor.clubId,
      ...(opts.playerTargetId ? { playerTargetId: opts.playerTargetId } : {}),
      ...(opts.playerId       ? { playerId: opts.playerId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 50, 500),
  });
}

// ── Recruitment scoring (deterministic, m1) ─────────────────────────────

export interface RecruitmentScoreInput {
  /** Mean scout score 0..100. */
  scoutMean:        number;
  /** Match-readiness score 0..1 from analytics. */
  matchReadiness:   number;
  /** Position-fit score 0..1. */
  positionFit:      number;
  /** Age-fit score 0..1 (prime years = 1.0). */
  ageFit:           number;
  /** Inverse normalized market value 0..1 (cheap = 1.0). */
  valueFit:         number;
}

export function computeRecruitmentScore(i: RecruitmentScoreInput): { score: number; components: Record<string, number>; version: string } {
  const score = Math.max(0, Math.min(1,
      0.30 * (i.scoutMean / 100)
    + 0.25 * i.matchReadiness
    + 0.20 * i.positionFit
    + 0.15 * i.ageFit
    + 0.10 * i.valueFit,
  ));
  return { score: Number(score.toFixed(3)), components: { ...i }, version: VERSION };
}

export interface PersistScoreDto {
  playerTargetId?: string;
  playerId?:       string;
  input:           RecruitmentScoreInput;
}

export async function persistRecruitmentScore(actor: RecruitActor, dto: PersistScoreDto): Promise<RecruitmentScore> {
  const out = computeRecruitmentScore(dto.input);
  return prisma.recruitmentScore.create({
    data: {
      clubId:         actor.clubId,
      playerTargetId: dto.playerTargetId ?? null,
      playerId:       dto.playerId ?? null,
      score:          out.score,
      components:     out.components as unknown as Prisma.InputJsonValue,
      modelVersion:   out.version,
    },
  });
}

// ── Transfer probability ────────────────────────────────────────────────

export interface TransferProbabilityInput {
  /** Contract remaining months. */
  contractRemainingMonths: number;
  /** Player satisfaction 0..1. */
  satisfaction:            number;
  /** Market demand 0..1 (more demand → higher P move). */
  marketDemand:            number;
  /** Wage gap 0..1 (positive = player paid below market). */
  wageGap:                 number;
}

export function computeTransferProbability(i: TransferProbabilityInput): { probability: number; components: Record<string, number>; version: string } {
  // P(move) high when contract short + low satisfaction + high demand + big wage gap.
  const cShort = Math.max(0, Math.min(1, 1 - i.contractRemainingMonths / 24));
  const dissat = Math.max(0, Math.min(1, 1 - i.satisfaction));
  const demand = Math.max(0, Math.min(1, i.marketDemand));
  const wage   = Math.max(0, Math.min(1, i.wageGap));
  const p = Math.max(0, Math.min(1, 0.35 * cShort + 0.25 * dissat + 0.25 * demand + 0.15 * wage));
  return { probability: Number(p.toFixed(3)), components: { cShort, dissat, demand, wage }, version: VERSION };
}

export async function persistTransferProbability(actor: RecruitActor, dto: { playerTargetId?: string; playerId?: string; horizonDays?: number; input: TransferProbabilityInput }): Promise<TransferProbability> {
  const out = computeTransferProbability(dto.input);
  return prisma.transferProbability.create({
    data: {
      clubId:         actor.clubId,
      playerTargetId: dto.playerTargetId ?? null,
      playerId:       dto.playerId ?? null,
      probability:    out.probability,
      horizonDays:    dto.horizonDays ?? 90,
      components:     out.components as unknown as Prisma.InputJsonValue,
      modelVersion:   out.version,
    },
  });
}

// ── Talent projection ───────────────────────────────────────────────────

export interface TalentProjectionInput {
  currentOVR:        number;
  age:               number;
  growthAttribute:   number;       // 0..100 e.g. composite "potential"
  injuryHistoryRisk: number;       // 0..1
}

export function computeTalentProjection(i: TalentProjectionInput, horizonYears = 3): { projectedOVR: number; components: Record<string, number>; version: string } {
  // Saturate growth at ~32 years. Decay risk.
  const ageDecay = Math.max(0, Math.min(1, (32 - i.age) / 14));
  const growth = (i.growthAttribute - i.currentOVR) * 0.35 * ageDecay * (1 - i.injuryHistoryRisk * 0.4);
  const projected = Math.round(Math.max(1, Math.min(99, i.currentOVR + growth * horizonYears)));
  return { projectedOVR: projected, components: { ageDecay, growth, ...i }, version: VERSION };
}

export async function persistTalentProjection(actor: RecruitActor, dto: { playerTargetId?: string; playerId?: string; horizonYears?: number; input: TalentProjectionInput }): Promise<TalentProjection> {
  const out = computeTalentProjection(dto.input, dto.horizonYears ?? 3);
  return prisma.talentProjection.create({
    data: {
      clubId:         actor.clubId,
      playerTargetId: dto.playerTargetId ?? null,
      playerId:       dto.playerId ?? null,
      horizonYears:   dto.horizonYears ?? 3,
      projectedOVR:   out.projectedOVR,
      components:     out.components as unknown as Prisma.InputJsonValue,
      modelVersion:   out.version,
    },
  });
}
