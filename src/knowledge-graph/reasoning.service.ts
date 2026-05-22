// Familista — Deterministic Reasoning Layer (Phase N)
// ─────────────────────────────────────────────────────────────────────────
// Every reasoning call:
//   1. Resolves the active DeterministicReasoningRule rows for the given
//      kind (per-club + global).
//   2. Evaluates rules in deterministic order (by code, then version desc).
//   3. Persists a ReasoningTrace with intermediate steps.
//   4. Persists an ExplainableDecision row signed with HMAC and hashed
//      into the Phase I audit chain.
//
// NO LLM in the reasoning path — pure deterministic. The LLM (Phase F)
// can still produce free-text recommendations, but those land in
// AIRecommendation (Phase E), not here.

import { createHash, createHmac } from 'crypto';
import { DeterministicReasoningRule, ExplainableDecision, Prisma, ReasoningKind, ReasoningTrace } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { config } from '../config';

export interface ReasonActor {
  userId: string;
  clubId: string;
  role?:  string;
}

const VERSION = 'n1';

// ── Rule lifecycle ──────────────────────────────────────────────────────

export interface PublishRuleDto {
  code:    string;
  label:   string;
  kind:    ReasoningKind;
  rule:    Prisma.InputJsonValue;
  global?: boolean;
}

export async function publishRule(actor: ReasonActor, dto: PublishRuleDto): Promise<DeterministicReasoningRule> {
  if (!dto.code || !dto.label || !dto.kind || dto.rule === undefined) throw new BadRequestError('code, label, kind, rule required');
  if (dto.global && actor.role !== 'SUPER_ADMIN')                      throw new ForbiddenError('Only SUPER_ADMIN may publish global rules');
  const clubScope = dto.global ? null : actor.clubId;
  // Determine next version per (clubScope, code).
  const last = await prisma.deterministicReasoningRule.findFirst({
    where:   { clubId: clubScope, code: dto.code },
    orderBy: { version: 'desc' },
    select:  { version: true },
  });
  const version = (last?.version ?? 0) + 1;
  return prisma.deterministicReasoningRule.create({
    data: {
      clubId:      clubScope,
      code:        dto.code,
      label:       dto.label,
      kind:        dto.kind,
      rule:        dto.rule,
      version,
      isActive:    true,
      publishedBy: actor.userId,
    },
  });
}

export async function listRules(actor: ReasonActor, kind?: ReasoningKind): Promise<DeterministicReasoningRule[]> {
  return prisma.deterministicReasoningRule.findMany({
    where: {
      isActive: true,
      OR: [{ clubId: actor.clubId }, { clubId: null }],
      ...(kind ? { kind } : {}),
    },
    orderBy: [{ code: 'asc' }, { version: 'desc' }],
  });
}

// ── Reasoning execution ─────────────────────────────────────────────────

export interface ReasonInput {
  /** Topic / question for the decision row. */
  topic:    string;
  question: string;
  kind:     ReasoningKind;
  /** Caller-supplied evidence pointers (e.g. ["GlobalKnowledgeNode:abc"]). */
  sources?: string[];
  /** Caller-supplied input bindings the rules consume. */
  inputs:   Record<string, unknown>;
}

export interface ReasonResult {
  trace:    ReasoningTrace;
  decision: ExplainableDecision;
}

/**
 * Deterministic reasoning engine. Evaluates active rules of the given
 * kind in (code asc, version desc) order. Each rule is a JSON object:
 *
 *   { when: [ { field, op, value }, ... ], then: { decision, weight } }
 *
 * Op values: "eq" | "ne" | "gt" | "lt" | "gte" | "lte" | "in" | "matches".
 *
 * The conclusion is the decision label with the highest summed weight.
 */
export async function reason(actor: ReasonActor, input: ReasonInput): Promise<ReasonResult> {
  if (!input.topic || !input.question || !input.kind) throw new BadRequestError('topic + question + kind required');
  const rules = await listRules(actor, input.kind);
  const steps: Array<{ ruleId: string; code: string; matched: boolean; contribution: number; decision?: string }> = [];
  const tally: Record<string, number> = {};

  for (const r of rules) {
    const rule = r.rule as { when?: Array<{ field: string; op: string; value: unknown }>; then?: { decision: string; weight?: number } };
    const cond = rule?.when ?? [];
    const all = cond.every((c) => evalPredicate(input.inputs, c.field, c.op, c.value));
    const contribution = all && rule.then ? (rule.then.weight ?? 1) : 0;
    if (all && rule.then) {
      tally[rule.then.decision] = (tally[rule.then.decision] ?? 0) + contribution;
    }
    steps.push({ ruleId: r.id, code: r.code, matched: all, contribution, decision: rule.then?.decision });
  }

  // Conclude: highest-tally decision; tie → 'INCONCLUSIVE'.
  let bestDecision = 'INCONCLUSIVE';
  let bestScore = 0;
  for (const [decision, score] of Object.entries(tally)) {
    if (score > bestScore) { bestScore = score; bestDecision = decision; }
    else if (score === bestScore && bestScore > 0) { bestDecision = 'INCONCLUSIVE'; }
  }

  // Persist trace.
  const trace = await prisma.reasoningTrace.create({
    data: {
      clubId:       actor.clubId,
      kind:         input.kind,
      question:     input.question,
      steps:        steps as unknown as Prisma.InputJsonValue,
      conclusion:   { decision: bestDecision, score: bestScore, tally } as unknown as Prisma.InputJsonValue,
      modelVersion: VERSION,
    },
  });

  // Build signed explainable decision.
  const sources = Array.isArray(input.sources) ? input.sources : [];
  const canonicalBody = JSON.stringify({ clubId: actor.clubId, topic: input.topic, decision: bestDecision, sources, traceId: trace.id });
  const payloadHash = createHash('sha256').update(canonicalBody).digest('hex');
  const key = createHmac('sha256', config.jwt.secret).update('decision|' + actor.clubId).digest();
  const signatureB64 = createHmac('sha256', key).update(canonicalBody).digest('base64');
  const decision = await prisma.explainableDecision.create({
    data: {
      clubId:       actor.clubId,
      traceId:      trace.id,
      topic:        input.topic,
      decision:     bestDecision,
      rationale:    `Decision="${bestDecision}" reached with score=${bestScore.toFixed(3)} over ${rules.length} active rule(s); ${steps.filter((s) => s.matched).length} matched.`,
      sources:      sources as unknown as Prisma.InputJsonValue,
      payloadHash,
      signatureB64,
      modelVersion: VERSION,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: `REASONING:${input.kind}`,
    entityType: 'ExplainableDecision', entityId: decision.id,
    payload: { topic: input.topic, decision: bestDecision, payloadHash, traceId: trace.id },
  });

  return { trace, decision };
}

export async function listTraces(actor: ReasonActor, kind?: ReasoningKind, limit = 50): Promise<ReasoningTrace[]> {
  return prisma.reasoningTrace.findMany({
    where: { clubId: actor.clubId, ...(kind ? { kind } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 500),
  });
}

export async function getDecision(actor: ReasonActor, id: string): Promise<ExplainableDecision> {
  const d = await prisma.explainableDecision.findUnique({ where: { id } });
  if (!d)                                                       throw new NotFoundError('ExplainableDecision');
  if (d.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return d;
}

// ── Pure-function predicate evaluator ──────────────────────────────────

function evalPredicate(inputs: Record<string, unknown>, field: string, op: string, value: unknown): boolean {
  const v = field.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), inputs);
  switch (op) {
    case 'eq':  return v === value;
    case 'ne':  return v !== value;
    case 'gt':  return typeof v === 'number' && typeof value === 'number' && v > value;
    case 'lt':  return typeof v === 'number' && typeof value === 'number' && v < value;
    case 'gte': return typeof v === 'number' && typeof value === 'number' && v >= value;
    case 'lte': return typeof v === 'number' && typeof value === 'number' && v <= value;
    case 'in':  return Array.isArray(value) && value.includes(v as never);
    case 'matches': return typeof v === 'string' && typeof value === 'string' && new RegExp(value).test(v);
    default:    return false;
  }
}
