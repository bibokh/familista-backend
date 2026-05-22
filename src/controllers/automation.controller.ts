// Familista — Automation + AI Agent controller (Phase B)

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../services/automation.service';
import { sendSuccess, sendCreated, sendNoContent, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const KINDS  = ['SCHEDULE_REPORT','INJURY_RISK_SCAN','TRAINING_PLAN','MATCH_PREVIEW','MATCH_RECAP','FATIGUE_SCAN','FINANCE_SUMMARY','COMMS_BROADCAST','DEVICE_HEALTHCHECK','DATA_PIPELINE','CUSTOM'] as const;
const STATUS = ['PENDING','RUNNING','SUCCESS','FAILED','CANCELLED'] as const;
const AGENTS = ['CLUB_MANAGER','TACTICAL','MEDICAL','SCOUTING','FINANCE','TRAINING','MATCH_OPS','COMMS','DEVICE_MGMT','BIG_DATA'] as const;

const taskCreateSchema = z.object({
  body: z.object({
    kind:        z.enum(KINDS),
    name:        z.string().trim().min(1).max(120),
    schedule:    z.string().max(120).nullable().optional(),
    isActive:    z.boolean().optional(),
    budgetCents: z.number().int().min(0).max(1_000_000_000).optional(),
    teamId:      z.string().uuid().nullable().optional(),
    params:      z.any().optional(),
  }),
});

const taskUpdateSchema = z.object({
  body: z.object({
    name:        z.string().trim().min(1).max(120).optional(),
    schedule:    z.string().max(120).nullable().optional(),
    isActive:    z.boolean().optional(),
    budgetCents: z.number().int().min(0).max(1_000_000_000).optional(),
    teamId:      z.string().uuid().nullable().optional(),
    params:      z.any().optional(),
  }).refine((b) => Object.keys(b).length > 0, { message: 'No fields supplied to update' }),
});

const taskListQuerySchema = z.object({
  query: z.object({
    kind:     z.enum(KINDS).optional(),
    isActive: z.enum(['true','false']).optional(),
    page:     z.coerce.number().int().min(1).max(10_000).optional(),
    limit:    z.coerce.number().int().min(1).max(200).optional(),
  }),
});

const agentEnqueueSchema = z.object({
  body: z.object({
    agent:  z.enum(AGENTS),
    kind:   z.string().trim().min(1).max(80),
    input:  z.any(),
    teamId: z.string().uuid().nullable().optional(),
    model:  z.string().max(80).optional(),
  }),
});

const agentListQuerySchema = z.object({
  query: z.object({
    agent:  z.enum(AGENTS).optional(),
    status: z.enum(STATUS).optional(),
    page:   z.coerce.number().int().min(1).max(10_000).optional(),
    limit:  z.coerce.number().int().min(1).max(200).optional(),
  }),
});

const reasonSchema = z.object({ body: z.object({ reason: z.string().max(500).optional() }) });

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}
function actorOf(req: Request): svc.AutomationActor {
  if (!req.user) throw new BadRequestError('Authentication context missing');
  const xff = req.headers['x-forwarded-for'];
  const ip  = typeof xff === 'string' ? xff.split(',')[0]?.trim() : req.ip;
  return {
    userId:    req.user.id,
    clubId:    req.user.clubId,
    ipAddress: ip ?? null,
    userAgent: (req.headers['user-agent'] as string) ?? null,
  };
}

// ── Tasks ────────────────────────────────────────────────────────────────

export async function createTask(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = taskCreateSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const t = await svc.createTask(actorOf(req), parsed.data.body as never);
    return sendCreated(res, t, 'Automation task created');
  } catch (err) { return next(err); }
}

export async function listTasks(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = taskListQuerySchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const q = parsed.data.query;
    const out = await svc.listTasks(req.user!.clubId, {
      kind:     q.kind,
      isActive: q.isActive === undefined ? undefined : q.isActive === 'true',
      page:     q.page,
      limit:    q.limit,
    });
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function getTask(req: Request, res: Response, next: NextFunction) {
  try {
    const t = await svc.getTask(req.params.id, req.user!.clubId);
    return sendSuccess(res, t);
  } catch (err) { return next(err); }
}

export async function updateTask(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = taskUpdateSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const t = await svc.updateTask(actorOf(req), req.params.id, parsed.data.body as never);
    return sendSuccess(res, t, 'Automation task updated');
  } catch (err) { return next(err); }
}

export async function deleteTask(req: Request, res: Response, next: NextFunction) {
  try {
    await svc.deleteTask(actorOf(req), req.params.id);
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

export async function triggerTask(req: Request, res: Response, next: NextFunction) {
  try {
    const run = await svc.triggerTask(actorOf(req), req.params.id);
    return sendCreated(res, run, 'Run enqueued');
  } catch (err) { return next(err); }
}

export async function listTaskRuns(req: Request, res: Response, next: NextFunction) {
  try {
    const page  = req.query.page  ? parseInt(req.query.page  as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
    const out = await svc.listRuns(req.params.id, req.user!.clubId, { page, limit });
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

// ── AI agent jobs ────────────────────────────────────────────────────────

export async function enqueueAgentJob(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = agentEnqueueSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const job = await svc.enqueueAgentJob(actorOf(req), parsed.data.body as never);
    return sendCreated(res, job, 'AI agent job enqueued');
  } catch (err) { return next(err); }
}

export async function listAgentJobs(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = agentListQuerySchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const q = parsed.data.query;
    const out = await svc.listAgentJobs(req.user!.clubId, {
      agent:  q.agent,
      status: q.status,
      page:   q.page,
      limit:  q.limit,
    });
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function getAgentJob(req: Request, res: Response, next: NextFunction) {
  try {
    const job = await svc.getAgentJob(req.params.id, req.user!.clubId);
    return sendSuccess(res, job);
  } catch (err) { return next(err); }
}

export async function cancelAgentJob(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = reasonSchema.safeParse({ body: req.body || {} });
    const reason = parsed.success ? parsed.data.body.reason : undefined;
    const job = await svc.cancelAgentJob(actorOf(req), req.params.id, reason);
    return sendSuccess(res, job, 'AI agent job cancelled');
  } catch (err) { return next(err); }
}
