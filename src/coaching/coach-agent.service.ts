// Familista — Autonomous Coaching Agents (Phase L)
// ─────────────────────────────────────────────────────────────────────────
// CoachAgent persons configured per club. Each emits CoachRecommendation
// rows. Every recommendation hashes into the Phase I audit chain.
// High-risk kinds (INJURY_RISK, SUBSTITUTION, FORMATION_OPTIMIZATION,
// MATCH_ADJUSTMENT, TACTICAL_ADAPTATION) request approval through Phase I.

import { createHash } from 'crypto';
import { AIAgent, AIDecisionImpact, CoachAgent, CoachRecommendation, CoachRecommendationKind, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { requestApproval, classifyRisk } from '../security/ai-approval.service';

export interface CoachActor {
  userId: string;
  clubId: string;
  role?:  string;
}

const HIGH_RISK_KINDS: CoachRecommendationKind[] = [
  'INJURY_RISK', 'SUBSTITUTION', 'FORMATION_OPTIMIZATION', 'MATCH_ADJUSTMENT', 'TACTICAL_ADAPTATION',
];

const VERSION = 'l1';

// ── Agent lifecycle ─────────────────────────────────────────────────────

export interface RegisterAgentDto {
  label:     string;
  agentKind: AIAgent;
  config?:   Prisma.InputJsonValue;
}

export async function registerAgent(actor: CoachActor, dto: RegisterAgentDto): Promise<CoachAgent> {
  if (!dto.label || !dto.agentKind) throw new BadRequestError('label + agentKind required');
  return prisma.coachAgent.create({
    data: {
      clubId:    actor.clubId,
      label:     dto.label,
      agentKind: dto.agentKind,
      config:    (dto.config ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

export async function listAgents(actor: CoachActor): Promise<CoachAgent[]> {
  return prisma.coachAgent.findMany({ where: { clubId: actor.clubId, isActive: true }, orderBy: { createdAt: 'desc' } });
}

export async function deactivateAgent(actor: CoachActor, id: string): Promise<CoachAgent> {
  const a = await prisma.coachAgent.findUnique({ where: { id } });
  if (!a)                                                       throw new NotFoundError('CoachAgent');
  if (a.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.coachAgent.update({ where: { id }, data: { isActive: false } });
}

// ── Recommendation lifecycle ────────────────────────────────────────────

export interface IssueRecommendationDto {
  matchId?:       string | null;
  teamId?:        string | null;
  playerId?:      string | null;
  agentId?:       string | null;
  kind:           CoachRecommendationKind;
  title?:         string;
  rationale:      string;
  payload:        Prisma.InputJsonValue;
  confidence?:    number;
  tacticalImpact?: AIDecisionImpact;
}

export async function issueRecommendation(actor: CoachActor, dto: IssueRecommendationDto): Promise<CoachRecommendation> {
  if (!dto.kind || !dto.rationale) throw new BadRequestError('kind + rationale required');
  const isHighRisk = HIGH_RISK_KINDS.includes(dto.kind);
  let approvalRequestId: string | null = null;

  // For high-risk kinds, create a Phase I approval request first.
  if (isHighRisk) {
    const approvalKind = classifyRisk(dto.kind, dto.payload) ?? 'OTHER';
    const approval = await requestApproval(
      { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
      { agent: dto.agentId ? 'TACTICAL' : 'TACTICAL', kind: approvalKind, payload: { recommendationKind: dto.kind, payload: dto.payload } as Prisma.InputJsonValue, jobId: null, ttlMs: 24 * 60 * 60_000 },
    );
    approvalRequestId = approval.id;
  }

  const hash = createHash('sha256').update(JSON.stringify(dto.payload ?? null)).digest('hex');
  const row = await prisma.coachRecommendation.create({
    data: {
      clubId:           actor.clubId,
      matchId:          dto.matchId ?? null,
      teamId:           dto.teamId ?? null,
      playerId:         dto.playerId ?? null,
      agentId:          dto.agentId ?? null,
      kind:             dto.kind,
      title:            dto.title ?? '',
      rationale:        dto.rationale,
      payload:          dto.payload,
      confidence:       Math.max(0, Math.min(1, dto.confidence ?? 0.5)),
      tacticalImpact:   dto.tacticalImpact ?? (isHighRisk ? 'HIGH' : 'LOW'),
      approvalRequestId,
      payloadHash:      hash,
      detectorVersion:  VERSION,
      status:           'OPEN',
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: `COACH_REC:${dto.kind}`,
    entityType: 'CoachRecommendation',
    entityId: row.id,
    payload: { kind: dto.kind, confidence: row.confidence, hash, approvalRequestId },
  });
  return row;
}

export async function listRecommendations(actor: CoachActor, opts: { matchId?: string; kind?: CoachRecommendationKind; playerId?: string; page?: number; limit?: number } = {}) {
  const { page = 1, limit = 50 } = opts;
  const where: Prisma.CoachRecommendationWhereInput = {
    clubId: actor.clubId,
    ...(opts.matchId  ? { matchId: opts.matchId } : {}),
    ...(opts.kind     ? { kind: opts.kind } : {}),
    ...(opts.playerId ? { playerId: opts.playerId } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.coachRecommendation.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: Math.min(limit, 500) }),
    prisma.coachRecommendation.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function ackRecommendation(actor: CoachActor, id: string): Promise<CoachRecommendation> {
  const r = await prisma.coachRecommendation.findUnique({ where: { id } });
  if (!r)                                                       throw new NotFoundError('CoachRecommendation');
  if (r.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return prisma.coachRecommendation.update({
    where: { id },
    data:  { status: 'ACK', ackedAt: new Date(), ackedBy: actor.userId },
  });
}
