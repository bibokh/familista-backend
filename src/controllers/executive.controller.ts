// Familista — Executive OS · Integration Layer
// File location: src/controllers/executive.controller.ts
//
// Sections:
//   1. Dashboard (CEO operating layer)
//   2. Executive RBAC
//   3. Workflows + attestations + step execution
//   4. Board resolutions + voting
//   5. Sponsor pipeline
//   6. Revenue forecasts
//   7. Risk monitoring + composite sweep
//   8. Audit

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';

import * as workflow from '../services/executive-workflow.service';
import * as board from '../services/executive-board.service';
import * as sponsor from '../services/executive-sponsor.service';
import * as forecast from '../services/executive-forecast.service';
import * as risk from '../services/executive-risk.service';
import * as dashboard from '../services/executive-dashboard.service';
import * as audit from '../services/executive-audit.service';
import { listKnownActions } from '../services/executive-step-executor.service';

import {
  upsertAssignmentSchema,
  createWorkflowSchema,
  transitionWorkflowSchema,
  updateStepSchema,
  attestSchema,
  createResolutionSchema,
  transitionResolutionSchema,
  castVoteSchema,
  createSponsorSchema,
  updateSponsorSchema,
  transitionSponsorStageSchema,
  generateForecastSchema,
  createRiskAlertSchema,
  updateRiskAlertSchema,
  executiveAuditQuerySchema,
} from '../utils/executive.validators';
import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { writeExecutiveAudit } from '../services/executive-audit.service';

function actorOf(req: Request) {
  if (!req.executiveActor) throw new ForbiddenError('Executive context required');
  return req.executiveActor;
}
function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.join('.') || 'body'}: ${e.message}`).join(', '));
}

// ─── 1. Dashboard ──────────────────────────────────────────────────────────

export async function getDashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await dashboard.buildDashboard(actor));
  } catch (err) { return next(err); }
}

export async function getKnownActions(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, { actions: listKnownActions() });
  } catch (err) { return next(err); }
}

// ─── 2. Executive RBAC ─────────────────────────────────────────────────────

export async function listAssignments(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required to list assignments');
    const items = await prisma.executiveAssignment.findMany({
      orderBy: [{ isActive: 'desc' }, { role: 'asc' }],
    });
    return sendSuccess(res, items);
  } catch (err) { return next(err); }
}

export async function upsertAssignment(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const input = upsertAssignmentSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new NotFoundError('User not found');

    const assignment = await prisma.executiveAssignment.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        role: input.role,
        voteWeight: input.voteWeight ?? 1.0,
        effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(),
        effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
        assignedBy: actor.userId,
        notes: input.notes ?? null,
      },
      update: {
        role: input.role,
        voteWeight: input.voteWeight ?? undefined,
        effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : undefined,
        effectiveTo: input.effectiveTo === undefined ? undefined : input.effectiveTo ? new Date(input.effectiveTo) : null,
        notes: input.notes ?? undefined,
        isActive: true,
      },
    });

    await writeExecutiveAudit({
      userId: actor.userId,
      action: 'ASSIGNMENT_UPSERTED',
      category: 'ACCESS',
      resourceType: 'ExecutiveAssignment',
      resourceId: assignment.id,
      metadata: { targetUserId: input.userId, role: input.role, voteWeight: input.voteWeight },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    return sendSuccess(res, assignment, 'Executive assignment saved');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function deactivateAssignment(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    if (!actor.scope.isPlatformAdmin) throw new ForbiddenError('Platform admin required');
    const assignment = await prisma.executiveAssignment.update({
      where: { userId: req.params.userId },
      data: { isActive: false, effectiveTo: new Date() },
    }).catch(() => null);
    if (!assignment) throw new NotFoundError('Assignment not found');

    await writeExecutiveAudit({
      userId: actor.userId,
      action: 'ASSIGNMENT_DEACTIVATED',
      category: 'ACCESS',
      resourceType: 'ExecutiveAssignment',
      resourceId: assignment.id,
      metadata: { targetUserId: req.params.userId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return sendNoContent(res);
  } catch (err) { return next(err); }
}

// ─── 3. Workflows ──────────────────────────────────────────────────────────

export async function listWorkflows(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await workflow.listWorkflows({
      kind: req.query.kind as never,
      status: req.query.status as never,
      clubId: req.query.clubId as string | undefined,
      franchiseUnitId: req.query.franchiseUnitId as string | undefined,
      investorId: req.query.investorId as string | undefined,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getWorkflow(req: Request, res: Response, next: NextFunction) {
  try { actorOf(req); return sendSuccess(res, await workflow.getWorkflow(req.params.id)); }
  catch (err) { return next(err); }
}

export async function createWorkflow(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = createWorkflowSchema.parse(req.body);
    return sendCreated(res, await workflow.createWorkflow(actor, input), 'Workflow created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function transitionWorkflow(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = transitionWorkflowSchema.parse(req.body);
    return sendSuccess(res, await workflow.transitionWorkflow(actor, req.params.id, input), 'Workflow updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function attestWorkflow(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = attestSchema.parse(req.body);
    return sendCreated(res, await workflow.attestWorkflow(actor, req.params.id, input), 'Attestation recorded');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function runNextStep(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await workflow.runNextStep(actor, req.params.id), 'Step executed');
  } catch (err) { return next(err); }
}

export async function markStepComplete(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = updateStepSchema.parse(req.body);
    return sendSuccess(res, await workflow.markStepComplete(actor, req.params.stepId, input), 'Step updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 4. Board ──────────────────────────────────────────────────────────────

export async function listResolutions(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await board.listResolutions({
      status: req.query.status as never,
      workflowId: req.query.workflowId as string | undefined,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getResolution(req: Request, res: Response, next: NextFunction) {
  try { actorOf(req); return sendSuccess(res, await board.getResolution(req.params.id)); }
  catch (err) { return next(err); }
}

export async function createResolution(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = createResolutionSchema.parse(req.body);
    return sendCreated(res, await board.createResolution(actor, input), 'Resolution drafted');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function transitionResolution(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = transitionResolutionSchema.parse(req.body);
    return sendSuccess(res, await board.transitionResolution(actor, req.params.id, input), 'Resolution updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function castVote(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = castVoteSchema.parse(req.body);
    return sendCreated(res, await board.castVote(actor, req.params.id, input), 'Vote recorded');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function tallyResolution(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await board.tallyAndClose(actor, req.params.id), 'Resolution tallied');
  } catch (err) { return next(err); }
}

// ─── 5. Sponsor pipeline ───────────────────────────────────────────────────

export async function listSponsors(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await sponsor.listSponsors({
      stage: req.query.stage as never,
      tier: req.query.tier as never,
      clubId: req.query.clubId as string | undefined,
      franchiseUnitId: req.query.franchiseUnitId as string | undefined,
      ownedBy: req.query.ownedBy as string | undefined,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getSponsor(req: Request, res: Response, next: NextFunction) {
  try { actorOf(req); return sendSuccess(res, await sponsor.getSponsor(req.params.id)); }
  catch (err) { return next(err); }
}

export async function createSponsor(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = createSponsorSchema.parse(req.body);
    return sendCreated(res, await sponsor.createSponsor(actor, input), 'Sponsor opportunity created');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateSponsor(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = updateSponsorSchema.parse(req.body);
    return sendSuccess(res, await sponsor.updateSponsor(actor, req.params.id, input), 'Sponsor opportunity updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function transitionSponsorStage(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = transitionSponsorStageSchema.parse(req.body);
    return sendSuccess(res, await sponsor.transitionSponsorStage(actor, req.params.id, input), 'Sponsor stage updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 6. Forecast ───────────────────────────────────────────────────────────

export async function generateForecast(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = generateForecastSchema.parse(req.body);
    return sendCreated(res, await forecast.generateForecast(actor, input), 'Forecast generated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function listForecasts(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await forecast.listForecasts({
      scope: req.query.scope as never,
      scopeId: req.query.scopeId as string | undefined,
      periodKey: req.query.periodKey as string | undefined,
      scenario: req.query.scenario as never,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

// ─── 7. Risk ───────────────────────────────────────────────────────────────

export async function listAlerts(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await risk.listAlerts({
      status: req.query.status as never,
      severity: req.query.severity as never,
      category: req.query.category as never,
      clubId: req.query.clubId as string | undefined,
      franchiseUnitId: req.query.franchiseUnitId as string | undefined,
      investorId: req.query.investorId as string | undefined,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getAlert(req: Request, res: Response, next: NextFunction) {
  try { actorOf(req); return sendSuccess(res, await risk.getAlert(req.params.id)); }
  catch (err) { return next(err); }
}

export async function upsertAlert(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = createRiskAlertSchema.parse(req.body);
    return sendCreated(res, await risk.upsertAlert(actor, input), 'Risk alert upserted');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function updateAlert(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = updateRiskAlertSchema.parse(req.body);
    return sendSuccess(res, await risk.updateAlert(actor, req.params.id, input), 'Risk alert updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function runRiskSweep(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    return sendSuccess(res, await risk.sweep(actor), 'Risk sweep completed');
  } catch (err) { return next(err); }
}

// ─── 8. Audit ──────────────────────────────────────────────────────────────

export async function searchAudit(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const q = executiveAuditQuerySchema.parse(req.query);
    return sendSuccess(res, await audit.searchExecutiveAudit(q));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function summarizeAudit(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const q = executiveAuditQuerySchema.parse(req.query);
    return sendSuccess(res, await audit.summarizeExecutiveAudit(q));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

void Prisma;
