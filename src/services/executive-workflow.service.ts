// Familista — Executive OS · Integration Layer
// File location: src/services/executive-workflow.service.ts
//
// Workflow lifecycle:
//   DRAFT → IN_REVIEW → AWAITING_APPROVAL → APPROVED → IN_EXECUTION → COMPLETED
//                                  ↓                                ↓
//                                REJECTED / CANCELLED            STALLED
//
// Attestations are required before AWAITING_APPROVAL → APPROVED. Each step
// runs through the step executor; results are persisted on the step row.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  AttestationDecision,
  ExecutiveRole,
  ExecutiveWorkflow,
  ExecutiveWorkflowStatus,
  WorkflowAttestation,
  WorkflowStep,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeExecutiveAudit } from './executive-audit.service';
import { executeStep } from './executive-step-executor.service';
import { findTemplate } from '../data/executive-workflow-templates';
import type {
  AttestInput,
  CreateWorkflowInput,
  TransitionWorkflowInput,
  UpdateStepInput,
} from '../utils/executive.validators';
import type { ExecutiveActor } from '../types/executive.types';

const TRANSITIONS: Record<ExecutiveWorkflowStatus, ReadonlyArray<ExecutiveWorkflowStatus>> = {
  DRAFT:             ['IN_REVIEW', 'CANCELLED'],
  IN_REVIEW:         ['AWAITING_APPROVAL', 'REJECTED', 'CANCELLED', 'DRAFT'],
  AWAITING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED', 'IN_REVIEW'],
  APPROVED:          ['IN_EXECUTION', 'CANCELLED'],
  IN_EXECUTION:      ['COMPLETED', 'STALLED', 'CANCELLED'],
  STALLED:           ['IN_EXECUTION', 'CANCELLED'],
  COMPLETED:         [],
  REJECTED:          [],
  CANCELLED:         [],
};

function assertTransition(from: ExecutiveWorkflowStatus, to: ExecutiveWorkflowStatus): void {
  if (from === to) return;
  if (!TRANSITIONS[from].includes(to)) {
    throw new BadRequestError(`Workflow transition ${from} → ${to} not allowed`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

export async function createWorkflow(
  actor: ExecutiveActor,
  input: CreateWorkflowInput,
): Promise<ExecutiveWorkflow & { steps: WorkflowStep[] }> {
  const template = input.templateSlug ? findTemplate(input.templateSlug) : null;
  if (input.templateSlug && !template) {
    throw new NotFoundError(`Workflow template "${input.templateSlug}" not found`);
  }
  if (template && template.kind !== input.kind) {
    throw new BadRequestError(`Template kind (${template.kind}) does not match input kind (${input.kind})`);
  }

  const steps = template
    ? template.steps.map((s) => ({
        order: s.order,
        name: s.name,
        description: s.description ?? null,
        engine: s.engine,
        action: s.action,
        params: {} as Prisma.InputJsonValue,
      }))
    : (input.customSteps ?? []).map((s, i) => ({
        order: i + 1,
        name: s.name,
        description: s.description ?? null,
        engine: s.engine,
        action: s.action,
        params: (s.params ?? {}) as Prisma.InputJsonValue,
      }));

  if (steps.length === 0 && input.kind !== 'CUSTOM') {
    throw new BadRequestError('Workflow requires at least one step (use a template or supply customSteps)');
  }

  const dueByAt = input.dueByAt
    ? new Date(input.dueByAt)
    : template?.defaultDueInDays
      ? new Date(Date.now() + template.defaultDueInDays * 24 * 60 * 60 * 1000)
      : null;

  const created = await prisma.$transaction(async (tx) => {
    const wf = await tx.executiveWorkflow.create({
      data: {
        kind: input.kind,
        templateSlug: input.templateSlug ?? null,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? template?.defaultPriority ?? 'NORMAL',
        clubId: input.clubId ?? null,
        franchiseUnitId: input.franchiseUnitId ?? null,
        investorId: input.investorId ?? null,
        entityId: input.entityId ?? null,
        sponsorOpportunityId: input.sponsorOpportunityId ?? null,
        matchId: input.matchId ?? null,
        decisionIds: input.decisionIds ?? [],
        requiredAttestations: template?.requiredAttestations ?? [],
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        initiatedBy: actor.userId,
        ownedBy: actor.userId,
        dueByAt,
      },
    });
    if (steps.length > 0) {
      await tx.workflowStep.createMany({
        data: steps.map((s) => ({ ...s, workflowId: wf.id })),
      });
    }
    return await tx.executiveWorkflow.findUniqueOrThrow({
      where: { id: wf.id },
      include: { steps: { orderBy: { order: 'asc' } } },
    });
  });

  await writeExecutiveAudit({
    workflowId: created.id,
    userId: actor.userId,
    action: 'WORKFLOW_CREATED',
    category: 'WORKFLOW',
    resourceType: 'ExecutiveWorkflow',
    resourceId: created.id,
    metadata: { kind: created.kind, templateSlug: created.templateSlug, steps: steps.length },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// State transitions
// ─────────────────────────────────────────────────────────────────────────────

export async function transitionWorkflow(
  actor: ExecutiveActor,
  id: string,
  input: TransitionWorkflowInput,
): Promise<ExecutiveWorkflow> {
  const existing = await prisma.executiveWorkflow.findUnique({
    where: { id },
    include: { attestations: true },
  });
  if (!existing) throw new NotFoundError('Workflow not found');

  assertTransition(existing.status, input.status);

  // Gate APPROVED on attestations
  if (input.status === 'APPROVED') {
    const requiredRoles = existing.requiredAttestations;
    const approveByRole = new Map<ExecutiveRole, AttestationDecision>();
    for (const a of existing.attestations) approveByRole.set(a.role, a.decision);
    const missing = requiredRoles.filter((r) => approveByRole.get(r) !== 'APPROVE');
    if (missing.length > 0) {
      throw new ConflictError(`Missing APPROVE attestations from: ${missing.join(', ')}`);
    }
  }

  const updated = await prisma.executiveWorkflow.update({
    where: { id },
    data: {
      status: input.status,
      startedAt: input.status === 'IN_EXECUTION' && !existing.startedAt ? new Date() : existing.startedAt,
      completedAt: input.status === 'COMPLETED' ? new Date() : existing.completedAt,
      cancelledAt: input.status === 'CANCELLED' ? new Date() : existing.cancelledAt,
      cancelledReason: input.status === 'CANCELLED' ? input.notes ?? null : existing.cancelledReason,
    },
  });

  await writeExecutiveAudit({
    workflowId: id,
    userId: actor.userId,
    action: `WORKFLOW_${input.status}`,
    category: 'WORKFLOW',
    resourceType: 'ExecutiveWorkflow',
    resourceId: id,
    metadata: { from: existing.status, to: input.status, notes: input.notes },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    result: input.status === 'REJECTED' || input.status === 'CANCELLED' ? 'REJECTED' : 'SUCCESS',
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attestations
// ─────────────────────────────────────────────────────────────────────────────

export async function attestWorkflow(
  actor: ExecutiveActor,
  workflowId: string,
  input: AttestInput,
): Promise<WorkflowAttestation> {
  const wf = await prisma.executiveWorkflow.findUnique({ where: { id: workflowId } });
  if (!wf) throw new NotFoundError('Workflow not found');
  if (!actor.scope.executiveRole) throw new BadRequestError('Actor has no executive role');

  if (wf.status !== 'AWAITING_APPROVAL' && wf.status !== 'IN_REVIEW') {
    throw new BadRequestError(`Cannot attest a workflow in status ${wf.status}`);
  }

  // Upsert by (workflowId, attesterUserId)
  const existing = await prisma.workflowAttestation.findUnique({
    where: { workflowId_attesterUserId: { workflowId, attesterUserId: actor.userId } },
  });

  const attestation = existing
    ? await prisma.workflowAttestation.update({
        where: { id: existing.id },
        data: {
          decision: input.decision,
          notes: input.notes ?? null,
          signatureRef: input.signatureRef ?? null,
          attestedAt: new Date(),
          role: actor.scope.executiveRole,
        },
      })
    : await prisma.workflowAttestation.create({
        data: {
          workflowId,
          attesterUserId: actor.userId,
          attesterAssignmentId: actor.scope.executiveAssignmentId,
          role: actor.scope.executiveRole,
          decision: input.decision,
          notes: input.notes ?? null,
          signatureRef: input.signatureRef ?? null,
        },
      });

  // If decision is REJECT and the workflow is awaiting approval, move it to REJECTED
  if (input.decision === 'REJECT' && wf.status === 'AWAITING_APPROVAL') {
    await prisma.executiveWorkflow.update({
      where: { id: workflowId },
      data: { status: 'REJECTED' },
    });
  }

  await writeExecutiveAudit({
    workflowId,
    userId: actor.userId,
    action: 'WORKFLOW_ATTESTED',
    category: 'ATTESTATION',
    resourceType: 'WorkflowAttestation',
    resourceId: attestation.id,
    metadata: { decision: input.decision, role: actor.scope.executiveRole },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    result: input.decision === 'REJECT' ? 'REJECTED' : 'SUCCESS',
  });

  return attestation;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step execution
// ─────────────────────────────────────────────────────────────────────────────

export async function runNextStep(
  actor: ExecutiveActor,
  workflowId: string,
): Promise<{ step: WorkflowStep; result: Awaited<ReturnType<typeof executeStep>>; workflowComplete: boolean }> {
  const wf = await prisma.executiveWorkflow.findUnique({
    where: { id: workflowId },
    include: { steps: { orderBy: { order: 'asc' } } },
  });
  if (!wf) throw new NotFoundError('Workflow not found');
  if (wf.status !== 'APPROVED' && wf.status !== 'IN_EXECUTION') {
    throw new BadRequestError(`Workflow must be APPROVED or IN_EXECUTION (current: ${wf.status})`);
  }

  const next = wf.steps.find((s) => s.status === 'PENDING' || s.status === 'BLOCKED');
  if (!next) {
    throw new BadRequestError('No pending or blocked step found');
  }

  if (wf.status === 'APPROVED') {
    await prisma.executiveWorkflow.update({
      where: { id: workflowId },
      data: { status: 'IN_EXECUTION', startedAt: wf.startedAt ?? new Date() },
    });
  }

  await prisma.workflowStep.update({
    where: { id: next.id },
    data: { status: 'IN_PROGRESS', startedAt: new Date(), startedBy: actor.userId, attemptCount: { increment: 1 } },
  });

  const stepParams = (next.params as Record<string, unknown>) ?? {};
  const result = await executeStep(actor, next.engine, next.action, stepParams);

  const finalStatus = result.ok
    ? (result.requiresHuman ? 'REQUIRES_HUMAN' : 'COMPLETED')
    : 'FAILED';

  const updatedStep = await prisma.workflowStep.update({
    where: { id: next.id },
    data: {
      status: finalStatus,
      completedAt: finalStatus === 'COMPLETED' ? new Date() : null,
      completedBy: finalStatus === 'COMPLETED' ? actor.userId : null,
      result: result.data === undefined ? undefined : (result.data as Prisma.InputJsonValue),
      error: result.error ?? null,
    },
  });

  // Check if workflow is now complete
  const remaining = await prisma.workflowStep.count({
    where: {
      workflowId,
      status: { in: ['PENDING', 'IN_PROGRESS', 'REQUIRES_HUMAN', 'BLOCKED', 'FAILED'] },
    },
  });
  const workflowComplete = remaining === 0;
  if (workflowComplete) {
    await prisma.executiveWorkflow.update({
      where: { id: workflowId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
  } else if (finalStatus === 'FAILED' && next.attemptCount + 1 >= (next.maxAttempts ?? 3)) {
    await prisma.executiveWorkflow.update({
      where: { id: workflowId },
      data: { status: 'STALLED' },
    });
  }

  await writeExecutiveAudit({
    workflowId,
    userId: actor.userId,
    action: result.ok ? 'STEP_COMPLETED' : 'STEP_FAILED',
    category: 'WORKFLOW',
    resourceType: 'WorkflowStep',
    resourceId: next.id,
    metadata: { order: next.order, engine: next.engine, action: next.action, requiresHuman: result.requiresHuman ?? false, error: result.error ?? null },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    result: result.ok ? 'SUCCESS' : 'FAILURE',
    message: result.error ?? null,
  });

  return { step: updatedStep, result, workflowComplete };
}

export async function markStepComplete(
  actor: ExecutiveActor,
  stepId: string,
  input: UpdateStepInput,
): Promise<WorkflowStep> {
  const step = await prisma.workflowStep.findUnique({ where: { id: stepId } });
  if (!step) throw new NotFoundError('Step not found');

  const updated = await prisma.workflowStep.update({
    where: { id: stepId },
    data: {
      status: input.status ?? 'COMPLETED',
      result:
        input.result === undefined ? undefined : input.result === null ? Prisma.JsonNull : (input.result as Prisma.InputJsonValue),
      error: input.error ?? undefined,
      blockedReason: input.blockedReason ?? undefined,
      completedAt: input.status === 'COMPLETED' || (!input.status && step.status === 'REQUIRES_HUMAN') ? new Date() : step.completedAt,
      completedBy: actor.userId,
    },
  });

  await writeExecutiveAudit({
    workflowId: step.workflowId,
    userId: actor.userId,
    action: 'STEP_MANUALLY_UPDATED',
    category: 'WORKFLOW',
    resourceType: 'WorkflowStep',
    resourceId: stepId,
    metadata: { changes: input },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export async function listWorkflows(opts: {
  kind?: ExecutiveWorkflow['kind'];
  status?: ExecutiveWorkflowStatus;
  clubId?: string;
  franchiseUnitId?: string;
  investorId?: string;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = await prisma.executiveWorkflow.findMany({
    where: {
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.clubId ? { clubId: opts.clubId } : {}),
      ...(opts.franchiseUnitId ? { franchiseUnitId: opts.franchiseUnitId } : {}),
      ...(opts.investorId ? { investorId: opts.investorId } : {}),
    },
    include: { _count: { select: { steps: true, attestations: true } } },
    orderBy: [{ priority: 'desc' }, { dueByAt: 'asc' }, { createdAt: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function getWorkflow(id: string) {
  const wf = await prisma.executiveWorkflow.findUnique({
    where: { id },
    include: {
      steps: { orderBy: { order: 'asc' } },
      attestations: { orderBy: { attestedAt: 'desc' } },
    },
  });
  if (!wf) throw new NotFoundError('Workflow not found');
  return wf;
}
