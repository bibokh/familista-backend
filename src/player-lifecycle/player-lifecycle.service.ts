// Familista — Player Lifecycle (Phase O)
// ─────────────────────────────────────────────────────────────────────────
// Onboarding workflow + recurring evaluations + active contracts.
// All audit-anchored. Contract state changes are approval-gateable via
// Phase I requestApproval when contract value exceeds club thresholds.

import { createHash } from 'crypto';
import { PlayerContractRecord, PlayerContractState, PlayerEvaluationRecord, PlayerOnboardingStep, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { requestApproval } from '../security/ai-approval.service';

export interface LifecycleActor {
  userId: string;
  clubId: string;
  role?:  string;
}

async function assertPlayerInClub(playerId: string, clubId: string): Promise<void> {
  const p = await prisma.player.findUnique({ where: { id: playerId }, select: { clubId: true } });
  if (!p)                  throw new NotFoundError('Player');
  if (p.clubId !== clubId) throw new ForbiddenError('Player not in club');
}

// ── Onboarding ──────────────────────────────────────────────────────────

const DEFAULT_ONBOARDING_STEPS = [
  'REGISTRATION', 'MEDICAL_FORM', 'PHOTO', 'PARENT_CONSENT', 'KIT_FIT', 'CONTRACT_REVIEW',
];

export async function seedOnboarding(actor: LifecycleActor, playerId: string): Promise<PlayerOnboardingStep[]> {
  await assertPlayerInClub(playerId, actor.clubId);
  const rows: PlayerOnboardingStep[] = [];
  for (const step of DEFAULT_ONBOARDING_STEPS) {
    const row = await prisma.playerOnboardingStep.upsert({
      where:  { playerId_step: { playerId, step } },
      create: { clubId: actor.clubId, playerId, step, completed: false },
      update: {},
    });
    rows.push(row);
  }
  return rows;
}

export async function completeOnboardingStep(actor: LifecycleActor, playerId: string, step: string, payload?: Prisma.InputJsonValue): Promise<PlayerOnboardingStep> {
  if (!playerId || !step) throw new BadRequestError('playerId + step required');
  await assertPlayerInClub(playerId, actor.clubId);
  const row = await prisma.playerOnboardingStep.upsert({
    where:  { playerId_step: { playerId, step } },
    create: { clubId: actor.clubId, playerId, step, completed: true, completedAt: new Date(), payload: (payload ?? Prisma.JsonNull) as Prisma.InputJsonValue },
    update: { completed: true, completedAt: new Date(), payload: (payload ?? Prisma.JsonNull) as Prisma.InputJsonValue },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'PLAYER_ONBOARDING_STEP_COMPLETED', entityType: 'PlayerOnboardingStep', entityId: row.id,
    payload: { playerId, step },
  });
  return row;
}

export async function listOnboarding(actor: LifecycleActor, playerId: string): Promise<PlayerOnboardingStep[]> {
  await assertPlayerInClub(playerId, actor.clubId);
  return prisma.playerOnboardingStep.findMany({ where: { playerId }, orderBy: { step: 'asc' } });
}

// ── Evaluations ─────────────────────────────────────────────────────────

export interface CreateEvaluationDto {
  playerId: string;
  kind:     string;
  payload:  Prisma.InputJsonValue;
  score?:   number;
  notes?:   string;
}

export async function recordEvaluation(actor: LifecycleActor, dto: CreateEvaluationDto): Promise<PlayerEvaluationRecord> {
  if (!dto.playerId || !dto.kind || dto.payload === undefined) throw new BadRequestError('playerId + kind + payload required');
  await assertPlayerInClub(dto.playerId, actor.clubId);
  return prisma.playerEvaluationRecord.create({
    data: {
      clubId:     actor.clubId,
      playerId:   dto.playerId,
      evaluatorId: actor.userId,
      kind:       dto.kind,
      payload:    dto.payload,
      score:      typeof dto.score === 'number' ? Math.max(0, Math.min(1, dto.score)) : null,
      notes:      dto.notes ?? null,
    },
  });
}

export async function listEvaluations(actor: LifecycleActor, playerId: string, opts: { kind?: string; limit?: number } = {}): Promise<PlayerEvaluationRecord[]> {
  await assertPlayerInClub(playerId, actor.clubId);
  return prisma.playerEvaluationRecord.findMany({
    where: { playerId, ...(opts.kind ? { kind: opts.kind } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 100, 1000),
  });
}

// ── Contracts ───────────────────────────────────────────────────────────

const HIGH_VALUE_THRESHOLD_CENTS = 1_000_000 * 100;     // €1M

export interface CreateContractDto {
  playerId:           string;
  startsAt:           string;
  endsAt?:            string;
  weeklyWageCents?:   number;
  signingBonusCents?: number;
  releaseClauseCents?: number;
  payload?:           Prisma.InputJsonValue;
}

export async function createContract(actor: LifecycleActor, dto: CreateContractDto): Promise<PlayerContractRecord> {
  if (!dto.playerId || !dto.startsAt) throw new BadRequestError('playerId + startsAt required');
  await assertPlayerInClub(dto.playerId, actor.clubId);
  const wage  = Math.max(0, dto.weeklyWageCents ?? 0);
  const bonus = Math.max(0, dto.signingBonusCents ?? 0);
  // Quick high-value detection — gate via Phase I approval before activation.
  const isHighValue = bonus >= HIGH_VALUE_THRESHOLD_CENTS || (wage * 52 * 5) >= HIGH_VALUE_THRESHOLD_CENTS;

  const payloadHash = createHash('sha256').update(JSON.stringify(dto.payload ?? null)).digest('hex');
  const row = await prisma.playerContractRecord.create({
    data: {
      clubId:             actor.clubId,
      playerId:           dto.playerId,
      state:              'DRAFT',
      startsAt:           new Date(dto.startsAt),
      endsAt:             dto.endsAt ? new Date(dto.endsAt) : null,
      weeklyWageCents:    wage,
      signingBonusCents:  bonus,
      releaseClauseCents: dto.releaseClauseCents ?? null,
      payload:            (dto.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      payloadHash,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'PLAYER_CONTRACT_DRAFTED', entityType: 'PlayerContractRecord', entityId: row.id,
    payload: { playerId: dto.playerId, weeklyWageCents: wage, signingBonusCents: bonus, isHighValue, payloadHash },
  });
  if (isHighValue) {
    await requestApproval(
      { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
      { agent: 'CLUB_MANAGER', kind: 'APPROVE_TRANSFER', payload: { contractId: row.id, payloadHash, isHighValue: true } as Prisma.InputJsonValue, jobId: null, ttlMs: 7 * 24 * 60 * 60_000 },
    );
  }
  return row;
}

export async function transitionContractState(actor: LifecycleActor, id: string, state: PlayerContractState): Promise<PlayerContractRecord> {
  const c = await prisma.playerContractRecord.findUnique({ where: { id } });
  if (!c)                                                       throw new NotFoundError('PlayerContractRecord');
  if (c.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  const data: Prisma.PlayerContractRecordUpdateInput = { state };
  if (state === 'ACTIVE')      data.signedAt     = new Date();
  if (state === 'TERMINATED')  data.terminatedAt = new Date();
  const updated = await prisma.playerContractRecord.update({ where: { id }, data });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: `PLAYER_CONTRACT_${state}`, entityType: 'PlayerContractRecord', entityId: id,
    payload: { playerId: c.playerId, state },
  });
  return updated;
}

export async function listContracts(actor: LifecycleActor, opts: { playerId?: string; state?: PlayerContractState; limit?: number } = {}): Promise<PlayerContractRecord[]> {
  return prisma.playerContractRecord.findMany({
    where: { clubId: actor.clubId, ...(opts.playerId ? { playerId: opts.playerId } : {}), ...(opts.state ? { state: opts.state } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 100, 1000),
  });
}
