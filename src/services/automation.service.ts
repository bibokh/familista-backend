// Familista — Automation + AI Agent data plane (Phase B)
// ─────────────────────────────────────────────────────────────────────────
// This is the INBOX for the future automation/AI worker fleet.
// Today we ship: CRUD over AutomationTask, AutomationRun, AIAgentJob.
// Tomorrow (Phase C): a cron loop + queue consumer drain these tables.
//
// Tenancy: every row is bound to clubId at write time. List queries are
// always filtered by the actor's clubId. teamId is optional, validated.

import {
  AutomationTask, AutomationRun, AutomationStatus, AutomationKind,
  AIAgentJob, AIAgent, Prisma,
} from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';

export interface AutomationActor {
  userId:     string;
  clubId:     string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Tenant helpers
// ─────────────────────────────────────────────────────────────────────────

async function assertTeamInClub(clubId: string, teamId?: string | null): Promise<void> {
  if (!teamId) return;
  const t = await prisma.team.findUnique({ where: { id: teamId }, select: { clubId: true } });
  if (!t)                  throw new NotFoundError('Team');
  if (t.clubId !== clubId) throw new ForbiddenError();
}

async function assertTaskInClub(taskId: string, clubId: string): Promise<AutomationTask> {
  const t = await prisma.automationTask.findUnique({ where: { id: taskId } });
  if (!t)                  throw new NotFoundError('AutomationTask');
  if (t.clubId !== clubId) throw new ForbiddenError();
  return t;
}

async function assertJobInClub(jobId: string, clubId: string): Promise<AIAgentJob> {
  const j = await prisma.aIAgentJob.findUnique({ where: { id: jobId } });
  if (!j)                  throw new NotFoundError('AIAgentJob');
  if (j.clubId !== clubId) throw new ForbiddenError();
  return j;
}

// ─────────────────────────────────────────────────────────────────────────
// AutomationTask (declarative recurring jobs)
// ─────────────────────────────────────────────────────────────────────────

export interface CreateAutomationTaskDto {
  kind:        AutomationKind;
  name:        string;
  schedule?:   string;        // cron OR ISO interval OR null=manual
  isActive?:   boolean;
  budgetCents?: number;
  teamId?:     string | null;
  params?:     Prisma.JsonValue;
}

export async function createTask(actor: AutomationActor, dto: CreateAutomationTaskDto): Promise<AutomationTask> {
  await assertTeamInClub(actor.clubId, dto.teamId ?? null);
  return prisma.automationTask.create({
    data: {
      clubId:      actor.clubId,
      teamId:      dto.teamId ?? null,
      kind:        dto.kind,
      name:        dto.name,
      schedule:    dto.schedule ?? null,
      isActive:    dto.isActive ?? true,
      budgetCents: dto.budgetCents ?? 0,
      params:      (dto.params ?? null) as Prisma.InputJsonValue,
      createdBy:   actor.userId,
    },
  });
}

export async function listTasks(clubId: string, filters: { kind?: AutomationKind; isActive?: boolean; page?: number; limit?: number } = {}) {
  const { kind, isActive, page = 1, limit = 50 } = filters;
  const where: Prisma.AutomationTaskWhereInput = {
    clubId,
    ...(kind && { kind }),
    ...(isActive !== undefined && { isActive }),
  };
  const [items, total] = await Promise.all([
    prisma.automationTask.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.automationTask.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getTask(taskId: string, clubId: string): Promise<AutomationTask> {
  return assertTaskInClub(taskId, clubId);
}

export interface UpdateAutomationTaskDto extends Partial<Omit<CreateAutomationTaskDto, 'kind'>> {
  isActive?: boolean;
}

export async function updateTask(actor: AutomationActor, taskId: string, dto: UpdateAutomationTaskDto): Promise<AutomationTask> {
  await assertTaskInClub(taskId, actor.clubId);
  if (dto.teamId !== undefined) await assertTeamInClub(actor.clubId, dto.teamId);
  return prisma.automationTask.update({
    where: { id: taskId },
    data: {
      ...(dto.name        !== undefined && { name:        dto.name }),
      ...(dto.schedule    !== undefined && { schedule:    dto.schedule }),
      ...(dto.isActive    !== undefined && { isActive:    dto.isActive }),
      ...(dto.budgetCents !== undefined && { budgetCents: dto.budgetCents }),
      ...(dto.teamId      !== undefined && { teamId:      dto.teamId ?? null }),
      ...(dto.params      !== undefined && { params:      dto.params as Prisma.InputJsonValue }),
    },
  });
}

export async function deleteTask(actor: AutomationActor, taskId: string): Promise<void> {
  await assertTaskInClub(taskId, actor.clubId);
  await prisma.automationTask.delete({ where: { id: taskId } });
}

// Manual trigger — drops a PENDING run for the worker fleet to pick up.
// (Workers themselves arrive in Phase C; this just creates the inbox entry.)
export async function triggerTask(actor: AutomationActor, taskId: string): Promise<AutomationRun> {
  const task = await assertTaskInClub(taskId, actor.clubId);
  return prisma.automationRun.create({
    data: { taskId: task.id, status: AutomationStatus.PENDING },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// AutomationRun (single execution receipt)
// ─────────────────────────────────────────────────────────────────────────

export async function listRuns(taskId: string, clubId: string, opts: { page?: number; limit?: number } = {}) {
  await assertTaskInClub(taskId, clubId);
  const { page = 1, limit = 50 } = opts;
  const where: Prisma.AutomationRunWhereInput = { taskId };
  const [items, total] = await Promise.all([
    prisma.automationRun.findMany({ where, orderBy: { startedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.automationRun.count({ where }),
  ]);
  return { items, total, page, limit };
}

// ─────────────────────────────────────────────────────────────────────────
// AIAgentJob (single agentic invocation)
// ─────────────────────────────────────────────────────────────────────────

export interface EnqueueAgentJobDto {
  agent:  AIAgent;
  kind:   string;             // e.g. TACTICAL.MATCH_REVIEW, MEDICAL.FATIGUE_SCAN
  input:  Prisma.JsonValue;
  teamId?: string | null;
  model?: string;
  triggeredBy?: string;
}

export async function enqueueAgentJob(actor: AutomationActor, dto: EnqueueAgentJobDto): Promise<AIAgentJob> {
  await assertTeamInClub(actor.clubId, dto.teamId ?? null);
  if (!dto.kind || dto.kind.length > 80) throw new BadRequestError('kind must be 1..80 chars');
  return prisma.aIAgentJob.create({
    data: {
      clubId:      actor.clubId,
      teamId:      dto.teamId ?? null,
      agent:       dto.agent,
      kind:        dto.kind,
      input:       dto.input as Prisma.InputJsonValue,
      status:      AutomationStatus.PENDING,
      model:       dto.model ?? null,
      triggeredBy: dto.triggeredBy ?? actor.userId,
    },
  });
}

export async function listAgentJobs(clubId: string, filters: { agent?: AIAgent; status?: AutomationStatus; page?: number; limit?: number } = {}) {
  const { agent, status, page = 1, limit = 50 } = filters;
  const where: Prisma.AIAgentJobWhereInput = {
    clubId,
    ...(agent  && { agent }),
    ...(status && { status }),
  };
  const [items, total] = await Promise.all([
    prisma.aIAgentJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.aIAgentJob.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getAgentJob(jobId: string, clubId: string): Promise<AIAgentJob> {
  return assertJobInClub(jobId, clubId);
}

// Cancel a pending job. Running jobs are flagged for cancellation;
// the (future) worker honours it on next checkpoint.
export async function cancelAgentJob(actor: AutomationActor, jobId: string, reason?: string): Promise<AIAgentJob> {
  const job = await assertJobInClub(jobId, actor.clubId);
  if (job.status === AutomationStatus.SUCCESS || job.status === AutomationStatus.FAILED || job.status === AutomationStatus.CANCELLED) {
    return job;
  }
  return prisma.aIAgentJob.update({
    where: { id: jobId },
    data: {
      status:     AutomationStatus.CANCELLED,
      finishedAt: new Date(),
      error:      reason ?? 'Cancelled by user',
    },
  });
}
