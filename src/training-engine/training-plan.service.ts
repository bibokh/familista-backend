// Familista — Autonomous Training Engine (Phase M)
// ─────────────────────────────────────────────────────────────────────────
// 5 plan kinds. All immutable once created (only status transitions
// DRAFT → ACTIVE → COMPLETED / CANCELED). Pure-function "scaffold"
// helpers produce deterministic baseline plans operators can edit.

import { LoadDistributionPlan, MicrocyclePlan, Prisma, RecoveryPlan, SeasonPlan, TrainingOptimizationPlan, TrainingPlanStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface TrainingActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ── TrainingOptimizationPlan ────────────────────────────────────────────

export interface CreateOptPlanDto {
  teamId?:  string;
  weekStart: string;
  payload:  Prisma.InputJsonValue;
}

export async function createOptimizationPlan(actor: TrainingActor, dto: CreateOptPlanDto): Promise<TrainingOptimizationPlan> {
  if (!dto.weekStart || dto.payload === undefined) throw new BadRequestError('weekStart + payload required');
  const row = await prisma.trainingOptimizationPlan.create({
    data: {
      clubId:      actor.clubId,
      teamId:      dto.teamId ?? null,
      weekStart:   new Date(dto.weekStart),
      payload:     dto.payload,
      createdById: actor.userId,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'TRAINING_OPT_PLAN_CREATED', entityType: 'TrainingOptimizationPlan', entityId: row.id,
    payload: { weekStart: row.weekStart, teamId: row.teamId },
  });
  return row;
}

export async function setOptPlanStatus(actor: TrainingActor, id: string, status: TrainingPlanStatus): Promise<TrainingOptimizationPlan> {
  const p = await prisma.trainingOptimizationPlan.findUnique({ where: { id } });
  if (!p)                                                       throw new NotFoundError('TrainingOptimizationPlan');
  if (p.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.trainingOptimizationPlan.update({ where: { id }, data: { status } });
}

// ── RecoveryPlan ────────────────────────────────────────────────────────

export interface CreateRecoveryDto {
  playerId: string;
  fromDate: string;
  toDate:   string;
  payload:  Prisma.InputJsonValue;
}

export async function createRecoveryPlan(actor: TrainingActor, dto: CreateRecoveryDto): Promise<RecoveryPlan> {
  if (!dto.playerId || !dto.fromDate || !dto.toDate) throw new BadRequestError('playerId + fromDate + toDate required');
  return prisma.recoveryPlan.create({
    data: {
      clubId:      actor.clubId,
      playerId:    dto.playerId,
      fromDate:    new Date(dto.fromDate),
      toDate:      new Date(dto.toDate),
      payload:     dto.payload,
      createdById: actor.userId,
    },
  });
}

// ── LoadDistributionPlan ────────────────────────────────────────────────

export async function createLoadPlan(actor: TrainingActor, dto: { teamId?: string; weekStart: string; payload: Prisma.InputJsonValue }): Promise<LoadDistributionPlan> {
  return prisma.loadDistributionPlan.create({
    data: { clubId: actor.clubId, teamId: dto.teamId ?? null, weekStart: new Date(dto.weekStart), payload: dto.payload },
  });
}

// ── MicrocyclePlan ──────────────────────────────────────────────────────

export async function createMicrocyclePlan(actor: TrainingActor, dto: { teamId?: string; weekStart: string; dailyPayload: Prisma.InputJsonValue }): Promise<MicrocyclePlan> {
  return prisma.microcyclePlan.create({
    data: { clubId: actor.clubId, teamId: dto.teamId ?? null, weekStart: new Date(dto.weekStart), dailyPayload: dto.dailyPayload },
  });
}

/** Pure-function: deterministic 7-day microcycle scaffold given intensity. */
export function microcycleScaffold(intensity: 'LOW' | 'NORMAL' | 'HIGH'): Array<{ day: string; session: string }> {
  const high = [
    { day: 'Mon', session: 'MD-3 — Tactical block + finishing' },
    { day: 'Tue', session: 'MD-2 — Set pieces + match scenarios' },
    { day: 'Wed', session: 'MD-1 — Activation + light tactical' },
    { day: 'Thu', session: 'MD — Match' },
    { day: 'Fri', session: 'MD+1 — Pool recovery' },
    { day: 'Sat', session: 'MD+2 — Light technical' },
    { day: 'Sun', session: 'MD+3 — Rest' },
  ];
  const normal = [
    { day: 'Mon', session: 'MD+1 — Recovery (low)' },
    { day: 'Tue', session: 'MD-4 — Strength + 3v3 small-sided' },
    { day: 'Wed', session: 'MD-3 — Tactical block + finishing' },
    { day: 'Thu', session: 'MD-2 — Set pieces + match scenarios' },
    { day: 'Fri', session: 'MD-1 — Activation + light tactical' },
    { day: 'Sat', session: 'MD — Match' },
    { day: 'Sun', session: 'MD+1 — Recovery' },
  ];
  const low = normal.map((s, i) => ({ ...s, session: i === 2 ? 'Mobility + position-specific film' : s.session }));
  return intensity === 'HIGH' ? high : intensity === 'LOW' ? low : normal;
}

// ── SeasonPlan ──────────────────────────────────────────────────────────

export async function upsertSeasonPlan(actor: TrainingActor, dto: { season: string; payload: Prisma.InputJsonValue }): Promise<SeasonPlan> {
  if (!dto.season) throw new BadRequestError('season required');
  return prisma.seasonPlan.upsert({
    where:  { clubId_season: { clubId: actor.clubId, season: dto.season } },
    create: { clubId: actor.clubId, season: dto.season, payload: dto.payload },
    update: { payload: dto.payload },
  });
}

export async function listPlans(actor: TrainingActor): Promise<{
  optimization: TrainingOptimizationPlan[];
  recovery:     RecoveryPlan[];
  load:         LoadDistributionPlan[];
  microcycle:   MicrocyclePlan[];
  season:       SeasonPlan[];
}> {
  const where = { clubId: actor.clubId };
  const [optimization, recovery, load, microcycle, season] = await Promise.all([
    prisma.trainingOptimizationPlan.findMany({ where, orderBy: { weekStart: 'desc' }, take: 20 }),
    prisma.recoveryPlan.findMany({ where, orderBy: { fromDate: 'desc' }, take: 20 }),
    prisma.loadDistributionPlan.findMany({ where, orderBy: { weekStart: 'desc' }, take: 20 }),
    prisma.microcyclePlan.findMany({ where, orderBy: { weekStart: 'desc' }, take: 20 }),
    prisma.seasonPlan.findMany({ where, orderBy: { season: 'desc' }, take: 5 }),
  ]);
  return { optimization, recovery, load, microcycle, season };
}
