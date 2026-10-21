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
import { AIReader, accessTier, assertAIReader, assertMayAct, assertNotDeclaredKind, listConditions, presentJob, presentList } from '../security/ai-read-policy';
import { publishAIRequestCreated } from '../fabric/producers/ai.producer';

export interface AutomationActor {
  userId:     string;
  clubId:     string;
  role?:      string | null;
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
}

export async function enqueueAgentJob(actor: AutomationActor, dto: EnqueueAgentJobDto): Promise<AIAgentJob> {
  await assertTeamInClub(actor.clubId, dto.teamId ?? null);
  if (!dto.kind || dto.kind.length > 80) throw new BadRequestError('kind must be 1..80 chars');
  // The input is the caller's; the job cannot pass as one the server assembled.
  assertNotDeclaredKind('job', dto.agent, dto.kind);
  const job = await prisma.aIAgentJob.create({
    data: {
      clubId:      actor.clubId,
      teamId:      dto.teamId ?? null,
      agent:       dto.agent,
      kind:        dto.kind,
      input:       dto.input as Prisma.InputJsonValue,
      status:      AutomationStatus.PENDING,
      model:       dto.model ?? null,
      // Always the authenticated actor: the approval gate reads this column as
      // the requester, so no caller may name somebody else.
      triggeredBy: actor.userId,
    },
  });

  // The request was ACCEPTED. Not the input — that is arbitrary JSON the
  // caller supplied and is the prompt in everything but name — and not the
  // free-text `kind`. The closed `AIAgent` enum travels, and the job id
  // becomes the correlation id every later event about this work carries.
  publishAIRequestCreated(
    {
      runId: job.id, clubId: job.clubId, teamId: job.teamId,
      correlationId: job.id, actorUserId: actor.userId, sourceType: 'USER',
    },
    job.agent,
  );
  return job;
}

// Who may see which jobs, and how much of each: src/security/ai-read-policy.ts.
// A list never carries a job's input, output or error.
export async function listAgentJobs(reader: AIReader, filters: { agent?: AIAgent; status?: AutomationStatus; page?: number; limit?: number } = {}) {
  const { agent, status, page = 1, limit = 50 } = filters;
  assertAIReader(reader);
  const readable = listConditions(reader, 'job', { agentNullable: false });
  if (!readable || !reader.clubId) return { items: [], total: 0, page, limit };
  const where = {
    clubId: reader.clubId,
    ...(agent  && { agent }),
    ...(status && { status }),
    AND: readable,
  } as Prisma.AIAgentJobWhereInput;
  const [rows, total] = await Promise.all([
    prisma.aIAgentJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.aIAgentJob.count({ where }),
  ]);
  const items = presentList(reader, 'job', rows, (j, tier) => presentJob(j, tier, 'list'));
  return { items, total, page, limit };
}

export async function getAgentJob(reader: AIReader, jobId: string) {
  const j = await prisma.aIAgentJob.findUnique({ where: { id: jobId } });
  if (!j) throw new NotFoundError('AIAgentJob');
  return presentJob(j, accessTier(reader, 'job', j, 'AIAgentJob'), 'detail');
}

// Cancel a pending job. Running jobs are flagged for cancellation;
// the (future) worker honours it on next checkpoint.
// A job that may hold medical data is cancelled by medical staff; any other by
// the roles the route has always allowed. Either way the canceller must be able
// to see the job, and the answer is the job at the tier they may read it.
const OPERATIONAL_CANCEL_ROLES = ['CLUB_ADMIN', 'HEAD_COACH'] as const;

export async function cancelAgentJob(actor: AutomationActor & AIReader, jobId: string, reason?: string) {
  const job = await prisma.aIAgentJob.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundError('AIAgentJob');
  const tier = accessTier(actor, 'job', job, 'AIAgentJob');
  assertMayAct(actor, 'job', job, tier, OPERATIONAL_CANCEL_ROLES, 'cancel');
  if (job.status === AutomationStatus.SUCCESS || job.status === AutomationStatus.FAILED || job.status === AutomationStatus.CANCELLED) {
    return presentJob(job, tier, 'detail');
  }
  return presentJob(await prisma.aIAgentJob.update({
    where: { id: jobId },
    data: {
      status:     AutomationStatus.CANCELLED,
      finishedAt: new Date(),
      error:      reason ?? 'Cancelled by user',
    },
  }), tier, 'detail');
}
