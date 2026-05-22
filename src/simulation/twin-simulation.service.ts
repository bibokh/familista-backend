// Familista — Twin Simulation Engine (Phase L)
// ─────────────────────────────────────────────────────────────────────────
// Branching what-if simulator over the Phase G digital twin.
//
// Determinism: each TwinSimulationSession carries `seed` (BigInt). All
// derived series (PredictedPossessionFlow, PredictedFatigueCurve) consume
// only (seed, branch divergence payload, source spatial frame) — replay
// with the same inputs reproduces identical series byte-for-byte.

import { CounterfactualScenario, MatchSimulationState, PredictedFatigueCurve, PredictedPossessionFlow, Prisma, SimulationStatus, TacticalBranch, TwinSimulationSession } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { randomBytes } from 'crypto';

export interface SimActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ── Sessions ────────────────────────────────────────────────────────────

export interface CreateSimDto {
  label:         string;
  matchId?:      string;
  sourceFrameId?: string;
  notes?:        string;
}

export async function createSession(actor: SimActor, dto: CreateSimDto): Promise<TwinSimulationSession> {
  if (!dto.label) throw new BadRequestError('label required');
  // Cap active sessions per club to prevent runaway resource use.
  const active = await prisma.twinSimulationSession.count({
    where: { clubId: actor.clubId, status: { in: ['DRAFT', 'RUNNING'] } },
  });
  if (active >= 20) throw new BadRequestError('Active simulation session cap (20) reached');

  const seed = randomBytes(8).readBigUInt64BE(0);
  return prisma.twinSimulationSession.create({
    data: {
      clubId:        actor.clubId,
      matchId:       dto.matchId ?? null,
      label:         dto.label,
      seed,
      sourceFrameId: dto.sourceFrameId ?? null,
      status:        'DRAFT',
      createdById:   actor.userId,
      notes:         dto.notes ?? null,
    },
  });
}

export async function listSessions(actor: SimActor, opts: { status?: SimulationStatus; matchId?: string; limit?: number } = {}): Promise<TwinSimulationSession[]> {
  return prisma.twinSimulationSession.findMany({
    where: {
      clubId: actor.clubId,
      ...(opts.status  ? { status: opts.status } : {}),
      ...(opts.matchId ? { matchId: opts.matchId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 50, 500),
  });
}

export async function setStatus(actor: SimActor, id: string, status: SimulationStatus): Promise<TwinSimulationSession> {
  const s = await prisma.twinSimulationSession.findUnique({ where: { id } });
  if (!s)                                                       throw new NotFoundError('TwinSimulationSession');
  if (s.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.twinSimulationSession.update({
    where: { id },
    data: {
      status,
      ...(status === 'RUNNING'   ? { startedAt: new Date() } : {}),
      ...(status === 'COMPLETED' || status === 'FAILED' ? { completedAt: new Date() } : {}),
    },
  });
}

// ── Branches ────────────────────────────────────────────────────────────

export interface CreateBranchDto {
  label:             string;
  parentBranchId?:   string;
  divergencePayload: Prisma.InputJsonValue;
}

export async function createBranch(actor: SimActor, sessionId: string, dto: CreateBranchDto): Promise<TacticalBranch> {
  const s = await prisma.twinSimulationSession.findUnique({ where: { id: sessionId } });
  if (!s)                                                       throw new NotFoundError('TwinSimulationSession');
  if (s.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.tacticalBranch.create({
    data: {
      sessionId,
      parentBranchId:    dto.parentBranchId ?? null,
      label:             dto.label,
      divergencePayload: dto.divergencePayload,
    },
  });
}

export async function listBranches(sessionId: string): Promise<TacticalBranch[]> {
  return prisma.tacticalBranch.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
}

// ── State snapshots ─────────────────────────────────────────────────────

export interface RecordStateDto {
  sessionId: string;
  branchId?: string;
  tickMs:    number;
  state:     Prisma.InputJsonValue;
}

export async function recordState(_actor: SimActor, dto: RecordStateDto): Promise<MatchSimulationState> {
  return prisma.matchSimulationState.create({
    data: {
      sessionId: dto.sessionId,
      branchId:  dto.branchId ?? null,
      tickMs:    BigInt(dto.tickMs),
      state:     dto.state,
    },
  });
}

export async function listStates(sessionId: string, branchId?: string, limit = 200): Promise<MatchSimulationState[]> {
  return prisma.matchSimulationState.findMany({
    where:   { sessionId, ...(branchId ? { branchId } : {}) },
    orderBy: { tickMs: 'asc' },
    take:    Math.min(limit, 5000),
  });
}

// ── Predicted curves + counterfactuals (write-only DTOs) ───────────────

export async function recordPossession(branchId: string, sessionId: string, series: Prisma.InputJsonValue): Promise<PredictedPossessionFlow> {
  return prisma.predictedPossessionFlow.create({ data: { sessionId, branchId, series } });
}

export async function recordFatigueCurve(branchId: string, sessionId: string, playerId: string, series: Prisma.InputJsonValue): Promise<PredictedFatigueCurve> {
  return prisma.predictedFatigueCurve.create({ data: { sessionId, branchId, playerId, series } });
}

export async function recordCounterfactual(actor: SimActor, sessionId: string, dto: { label: string; description?: string; branchId?: string; outcome?: Prisma.InputJsonValue }): Promise<CounterfactualScenario> {
  const s = await prisma.twinSimulationSession.findUnique({ where: { id: sessionId } });
  if (!s)                                                       throw new NotFoundError('TwinSimulationSession');
  if (s.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.counterfactualScenario.create({
    data: {
      sessionId,
      branchId:    dto.branchId ?? null,
      label:       dto.label,
      description: dto.description ?? null,
      outcome:     (dto.outcome ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

export async function listCounterfactuals(sessionId: string): Promise<CounterfactualScenario[]> {
  return prisma.counterfactualScenario.findMany({ where: { sessionId }, orderBy: { createdAt: 'desc' } });
}
