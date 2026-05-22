// Familista — AI Operations controller (Phase E)
// REST endpoints for alerts / recommendations / reports.

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import * as svc from '../services/ai-ops.service';
import * as anomaly from '../services/anomaly-detector.service';
import { sendSuccess, sendCreated, sendPaginated } from '../utils/response';
import { BadRequestError } from '../utils/errors';
import type { Prisma } from '@prisma/client';

const AGENTS = ['CLUB_MANAGER','TACTICAL','MEDICAL','SCOUTING','FINANCE','TRAINING','MATCH_OPS','COMMS','DEVICE_MGMT','BIG_DATA'] as const;
const SEVERITIES = ['INFO','WARN','CRITICAL'] as const;
const STATUSES = ['OPEN','ACK','RESOLVED','MUTED'] as const;

function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.slice(1).join('.') || e.path[0] || 'body'}: ${e.message}`).join(', '),
  );
}

// ── Alerts ──────────────────────────────────────────────────────────────

const createAlertSchema = z.object({
  body: z.object({
    matchId:  z.string().uuid().nullable().optional(),
    teamId:   z.string().uuid().nullable().optional(),
    playerId: z.string().uuid().nullable().optional(),
    agent:    z.enum(AGENTS).nullable().optional(),
    kind:     z.string().trim().min(1).max(80),
    severity: z.enum(SEVERITIES).optional(),
    title:    z.string().trim().max(200).optional(),
    message:  z.string().trim().max(2000).optional(),
    payload:  z.any().optional(),
  }),
});

const listAlertSchema = z.object({
  query: z.object({
    matchId:  z.string().uuid().optional(),
    status:   z.enum(STATUSES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    kind:     z.string().optional(),
    page:     z.coerce.number().int().min(1).max(10_000).optional(),
    limit:    z.coerce.number().int().min(1).max(200).optional(),
  }),
});

export async function createAlert(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createAlertSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const a = await svc.createAlert({ ...parsed.data.body, clubId: req.user!.clubId });
    return sendCreated(res, a);
  } catch (err) { return next(err); }
}

export async function listAlerts(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listAlertSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await svc.listAlerts(req.user!.clubId, parsed.data.query);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function ackAlert(req: Request, res: Response, next: NextFunction) {
  try {
    const a = await svc.ackAlert({ userId: req.user!.id, clubId: req.user!.clubId, role: req.user!.role }, req.params.id);
    return sendSuccess(res, a, 'Acknowledged');
  } catch (err) { return next(err); }
}

export async function resolveAlert(req: Request, res: Response, next: NextFunction) {
  try {
    const a = await svc.resolveAlert({ userId: req.user!.id, clubId: req.user!.clubId, role: req.user!.role }, req.params.id);
    return sendSuccess(res, a, 'Resolved');
  } catch (err) { return next(err); }
}

export async function muteAlert(req: Request, res: Response, next: NextFunction) {
  try {
    const a = await svc.muteAlert({ userId: req.user!.id, clubId: req.user!.clubId, role: req.user!.role }, req.params.id);
    return sendSuccess(res, a, 'Muted');
  } catch (err) { return next(err); }
}

// ── Recommendations ─────────────────────────────────────────────────────

const createRecSchema = z.object({
  body: z.object({
    matchId:  z.string().uuid().nullable().optional(),
    teamId:   z.string().uuid().nullable().optional(),
    playerId: z.string().uuid().nullable().optional(),
    agent:    z.enum(AGENTS),
    kind:     z.string().trim().min(1).max(80),
    title:    z.string().trim().max(200).optional(),
    content:  z.any(),
    score:    z.number().min(0).max(1).optional(),
  }).refine((v) => v.content !== undefined && v.content !== null, { message: 'content is required', path: ['content'] }),
});

const listRecSchema = z.object({
  query: z.object({
    matchId: z.string().uuid().optional(),
    status:  z.enum(STATUSES).optional(),
    agent:   z.enum(AGENTS).optional(),
    page:    z.coerce.number().int().min(1).max(10_000).optional(),
    limit:   z.coerce.number().int().min(1).max(200).optional(),
  }),
});

export async function createRecommendation(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createRecSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;
    const r = await svc.createRecommendation({
      ...body,
      clubId:  req.user!.clubId,
      content: body.content as never,
    });
    return sendCreated(res, r);
  } catch (err) { return next(err); }
}

export async function listRecommendations(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listRecSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await svc.listRecommendations(req.user!.clubId, parsed.data.query);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function ackRecommendation(req: Request, res: Response, next: NextFunction) {
  try {
    const r = await svc.ackRecommendation({ userId: req.user!.id, clubId: req.user!.clubId, role: req.user!.role }, req.params.id);
    return sendSuccess(res, r, 'Acknowledged');
  } catch (err) { return next(err); }
}

// ── Reports ─────────────────────────────────────────────────────────────

const createReportSchema = z.object({
  body: z.object({
    matchId: z.string().uuid().nullable().optional(),
    teamId:  z.string().uuid().nullable().optional(),
    agent:   z.enum(AGENTS),
    kind:    z.string().trim().min(1).max(80),
    title:   z.string().trim().min(1).max(200),
    content: z.string().min(1),
    payload: z.any().optional(),
  }),
});

const listReportSchema = z.object({
  query: z.object({
    matchId: z.string().uuid().optional(),
    agent:   z.enum(AGENTS).optional(),
    kind:    z.string().optional(),
    page:    z.coerce.number().int().min(1).max(10_000).optional(),
    limit:   z.coerce.number().int().min(1).max(200).optional(),
  }),
});

export async function createReport(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createReportSchema.safeParse({ body: req.body });
    if (!parsed.success) throw zerr(parsed.error);
    const r = await svc.createReport({ ...parsed.data.body, clubId: req.user!.clubId });
    return sendCreated(res, r);
  } catch (err) { return next(err); }
}

export async function listReports(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listReportSchema.safeParse({ query: req.query });
    if (!parsed.success) throw zerr(parsed.error);
    const out = await svc.listReports(req.user!.clubId, parsed.data.query);
    return sendPaginated(res, out.items, out.total, out.page, out.limit);
  } catch (err) { return next(err); }
}

export async function getReport(req: Request, res: Response, next: NextFunction) {
  try {
    const r = await svc.getReport({ userId: req.user!.id, clubId: req.user!.clubId, role: req.user!.role }, req.params.id);
    return sendSuccess(res, r);
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// Phase F · Agent run + anomaly endpoints
// ─────────────────────────────────────────────────────────────────────────

const runAgentSchema = z.object({
  body: z.object({
    kind:    z.string().trim().min(1).max(80).default('AD_HOC'),
    teamId:  z.string().uuid().optional(),
    matchId: z.string().uuid().optional(),
    input:   z.any().optional(),
  }),
});

export async function runAgent(req: Request, res: Response, next: NextFunction) {
  try {
    const agentParam = String(req.params.agent || '').toUpperCase();
    if (!(AGENTS as readonly string[]).includes(agentParam)) {
      throw new BadRequestError(`Unknown agent: ${agentParam}. Allowed: ${AGENTS.join(', ')}`);
    }
    const parsed = runAgentSchema.safeParse({ body: req.body ?? {} });
    if (!parsed.success) throw zerr(parsed.error);
    const body = parsed.data.body;

    // Enqueue an AIAgentJob — the worker will pick it up on its next tick
    // (deterministic handler first, LLM fallback only if configured).
    const job = await prisma.aIAgentJob.create({
      data: {
        clubId: req.user!.clubId,
        teamId: body.teamId ?? null,
        agent:  agentParam as never,
        kind:   body.kind,
        input:  (body.input ?? { matchId: body.matchId, teamId: body.teamId, kind: body.kind }) as Prisma.InputJsonValue,
        status: 'PENDING',
        triggeredBy: req.user!.id,
      },
      select: { id: true, agent: true, kind: true, status: true, createdAt: true },
    });
    return sendCreated(res, job, `Enqueued ${agentParam} job`);
  } catch (err) { return next(err); }
}

export async function getAgentJob(req: Request, res: Response, next: NextFunction) {
  try {
    const j = await prisma.aIAgentJob.findUnique({ where: { id: req.params.id } });
    if (!j) throw new BadRequestError('Job not found');
    if (j.clubId !== req.user!.clubId && req.user!.role !== 'SUPER_ADMIN') throw new BadRequestError('Forbidden');
    return sendSuccess(res, j);
  } catch (err) { return next(err); }
}

export async function scanAnomalies(req: Request, res: Response, next: NextFunction) {
  try {
    const report = await anomaly.scanClub(req.user!.clubId);
    return sendSuccess(res, report);
  } catch (err) { return next(err); }
}

export async function materialiseAnomalies(req: Request, res: Response, next: NextFunction) {
  try {
    const report = await anomaly.scanClub(req.user!.clubId);
    const out = await anomaly.materialiseAlerts(req.user!.clubId, report);
    return sendSuccess(res, { ...out, scanned: report.anomalies.length });
  } catch (err) { return next(err); }
}
