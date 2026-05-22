// Familista — AI Agent Decision framework (Phase J)
// ─────────────────────────────────────────────────────────────────────────
// Every agent run produces ONE AIAgentDecision row capturing:
//   - rationale      (free text the panel renders)
//   - sourceTelemetry (compact snapshot of inputs that drove the decision)
//   - confidence     (0..1)
//   - tacticalImpact (LOW | MEDIUM | HIGH — drives whether it should alert)
//   - approvalRequestId (Phase I link if the action was high-risk)
//   - payloadHash    (sha256 — anchor for the audit chain)
//
// This sits BETWEEN the worker (Phase B/C/F) and the audit chain (Phase I).
// Worker calls `recordDecision()` after a deterministic handler or LLM run.

import { createHash } from 'crypto';
import { AIAgent, AIAgentDecision, AIDecisionImpact, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { logger } from '../utils/logger';

export interface RecordDecisionInput {
  clubId:            string;
  matchId?:          string | null;
  teamId?:           string | null;
  agent:             AIAgent;
  kind:              string;
  jobId?:            string | null;
  rationale:         string;
  sourceTelemetry:   Prisma.InputJsonValue;
  confidence?:       number;
  tacticalImpact?:   AIDecisionImpact;
  approvalRequestId?: string | null;
  payload?:          Prisma.InputJsonValue | null;
  modelVersion?:     string;
  backend?:          'deterministic' | 'llm' | 'hybrid';
}

function payloadHash(payload: Prisma.InputJsonValue | null | undefined): string {
  const seed = JSON.stringify(payload ?? null);
  return createHash('sha256').update(seed).digest('hex');
}

export async function recordDecision(input: RecordDecisionInput): Promise<AIAgentDecision> {
  const hash = payloadHash(input.payload ?? null);
  const row = await prisma.aIAgentDecision.create({
    data: {
      clubId:           input.clubId,
      matchId:          input.matchId ?? null,
      teamId:           input.teamId ?? null,
      agent:            input.agent,
      kind:             input.kind,
      jobId:            input.jobId ?? null,
      rationale:        input.rationale,
      sourceTelemetry:  input.sourceTelemetry,
      confidence:       Math.max(0, Math.min(1, input.confidence ?? 0.5)),
      tacticalImpact:   input.tacticalImpact ?? 'LOW',
      approvalRequestId: input.approvalRequestId ?? null,
      payload:          (input.payload ?? null) as Prisma.InputJsonValue,
      payloadHash:      hash,
      modelVersion:     input.modelVersion ?? 'v1',
      backend:          input.backend ?? 'deterministic',
    },
  });
  // Anchor the decision in the audit chain — best-effort.
  appendAuditEventAsync({
    actor:      { userId: null, clubId: input.clubId, ipAddress: null, userAgent: null },
    action:     `AI_DECISION:${input.agent}:${input.kind}`,
    entityType: 'AIAgentDecision',
    entityId:   row.id,
    teamId:     input.teamId ?? null,
    payload:    { kind: input.kind, hash, confidence: row.confidence, impact: row.tacticalImpact },
  });
  return row;
}

export interface ListDecisionOpts {
  matchId?: string;
  agent?:   AIAgent;
  impact?:  AIDecisionImpact;
  page?:    number;
  limit?:   number;
}

export async function listDecisions(clubId: string, opts: ListDecisionOpts = {}) {
  const { page = 1, limit = 50 } = opts;
  const where: Prisma.AIAgentDecisionWhereInput = {
    clubId,
    ...(opts.matchId ? { matchId: opts.matchId } : {}),
    ...(opts.agent   ? { agent: opts.agent } : {}),
    ...(opts.impact  ? { tacticalImpact: opts.impact } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.aIAgentDecision.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    Math.min(limit, 500),
    }),
    prisma.aIAgentDecision.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getDecision(id: string, clubId: string): Promise<AIAgentDecision | null> {
  const d = await prisma.aIAgentDecision.findUnique({ where: { id } });
  if (!d || d.clubId !== clubId) return null;
  return d;
}

/** Convenience: derive impact from confidence + agent kind. */
export function impactFor(confidence: number, agentKind: string): AIDecisionImpact {
  const high = confidence >= 0.85;
  const med  = confidence >= 0.6;
  const k = (agentKind || '').toUpperCase();
  // High-impact agent kinds even at lower confidence.
  if (high || k.includes('INJURY') || k.includes('SUB') || k.includes('TRANSFER')) return 'HIGH';
  if (med) return 'MEDIUM';
  return 'LOW';
}
