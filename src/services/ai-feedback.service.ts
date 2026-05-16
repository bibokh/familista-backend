// Familista — AI Decision Engine
// File location: src/services/ai-feedback.service.ts
//
// Closes the feedback loop: users record outcomes, ratings, overrides, and
// corrections against existing decisions. The aggregate signal feeds future
// model tuning (operators inspect via the audit / history endpoints).

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type { AIDecisionFeedback, AIOutcome } from '@prisma/client';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { writeAIAudit } from './ai-audit.service';
import type { SubmitFeedbackInput, RecordOutcomeInput } from '../utils/ai-engine.validators';
import type { AIActor } from '../types/ai-engine.types';

export async function submitFeedback(
  actor: AIActor,
  decisionId: string,
  input: SubmitFeedbackInput,
): Promise<AIDecisionFeedback> {
  const decision = await prisma.aIDecision.findUnique({ where: { id: decisionId } });
  if (!decision) throw new NotFoundError('Decision not found');
  if (decision.status === 'EXPIRED') throw new BadRequestError('Cannot leave feedback on an expired decision');

  const feedback = await prisma.aIDecisionFeedback.create({
    data: {
      decisionId,
      type: input.type,
      rating: input.rating ?? null,
      notes: input.notes ?? null,
      correctedAction:
        input.correctedAction === undefined || input.correctedAction === null
          ? undefined
          : (input.correctedAction as Prisma.InputJsonValue),
      userId: actor.userId,
    },
  });

  // OVERRIDE / CORRECTION feedback also flips the parent decision status so
  // dashboards immediately reflect operator dissent.
  if (input.type === 'OVERRIDE') {
    await prisma.aIDecision.update({
      where: { id: decisionId },
      data: { status: 'OVERRIDDEN', reviewedBy: actor.userId, reviewedAt: new Date(), reviewNotes: input.notes ?? 'Overridden via feedback' },
    });
  }
  if (input.type === 'ACCEPTANCE') {
    await prisma.aIDecision.update({
      where: { id: decisionId },
      data: { status: 'ACCEPTED', reviewedBy: actor.userId, reviewedAt: new Date() },
    });
  }

  await writeAIAudit({
    decisionId,
    userId: actor.userId,
    action: 'DECISION_FEEDBACK',
    category: 'FEEDBACK',
    metadata: { type: input.type, rating: input.rating, hasCorrection: !!input.correctedAction },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return feedback;
}

export async function recordOutcome(
  actor: AIActor,
  decisionId: string,
  input: RecordOutcomeInput,
): Promise<void> {
  const decision = await prisma.aIDecision.findUnique({ where: { id: decisionId } });
  if (!decision) throw new NotFoundError('Decision not found');

  await prisma.aIDecision.update({
    where: { id: decisionId },
    data: {
      outcome: input.outcome as AIOutcome,
      outcomeAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      outcomeNotes: input.notes ?? null,
    },
  });

  await prisma.aIDecisionFeedback.create({
    data: {
      decisionId,
      type: 'OUTCOME_REPORT',
      notes: input.notes ?? null,
      userId: actor.userId,
    },
  });

  await writeAIAudit({
    decisionId,
    userId: actor.userId,
    action: 'DECISION_OUTCOME_RECORDED',
    category: 'FEEDBACK',
    metadata: { outcome: input.outcome, occurredAt: input.occurredAt ?? null },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

export async function listFeedback(decisionId: string): Promise<AIDecisionFeedback[]> {
  return await prisma.aIDecisionFeedback.findMany({
    where: { decisionId },
    orderBy: { createdAt: 'desc' },
  });
}

// Aggregated stats per model + decisionType — used to detect drift / churn
export async function modelFeedbackStats(modelId: string) {
  const decisions = await prisma.aIDecision.findMany({
    where: { modelId },
    select: { id: true, status: true, outcome: true, score: true },
  });
  const total = decisions.length;
  if (total === 0) {
    return { modelId, total, acceptanceRate: 0, overrideRate: 0, positiveOutcomeRate: 0, avgScore: null };
  }
  const accepted = decisions.filter((d) => d.status === 'ACCEPTED').length;
  const overridden = decisions.filter((d) => d.status === 'OVERRIDDEN' || d.status === 'REJECTED').length;
  const positive = decisions.filter((d) => d.outcome === 'POSITIVE').length;
  const avgScore = decisions.reduce((s, d) => s + d.score, 0) / total;

  return {
    modelId,
    total,
    acceptanceRate: Math.round((accepted / total) * 1000) / 1000,
    overrideRate: Math.round((overridden / total) * 1000) / 1000,
    positiveOutcomeRate: Math.round((positive / total) * 1000) / 1000,
    avgScore: Math.round(avgScore * 100) / 100,
  };
}
