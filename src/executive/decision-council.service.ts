// Familista — Multi-Agent Decision Council (Phase M)
// ─────────────────────────────────────────────────────────────────────────
// A DecisionCouncil aggregates votes from N AI agents (and optional humans)
// on a single proposal. Consensus is DETERMINISTIC: votes sorted by voterId
// then folded into approvals / rejections / abstentions, producing the
// same consensusScore byte-for-byte on replay.

import { CouncilStatus, CouncilVote, CouncilVoteType, DecisionCouncil, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface CouncilActor {
  userId: string;
  clubId: string;
  role?:  string;
}

export interface CreateCouncilDto {
  topic:    string;
  agentIds: string[];
  payload:  Prisma.InputJsonValue;
}

export async function createCouncil(actor: CouncilActor, dto: CreateCouncilDto): Promise<DecisionCouncil> {
  if (!dto.topic || !Array.isArray(dto.agentIds) || dto.agentIds.length === 0 || dto.payload === undefined) {
    throw new BadRequestError('topic + agentIds + payload required');
  }
  if (dto.agentIds.length > 50) throw new BadRequestError('agentIds capped at 50');
  const row = await prisma.decisionCouncil.create({
    data: {
      clubId:   actor.clubId,
      topic:    dto.topic,
      status:   'OPEN',
      agentIds: dto.agentIds as unknown as Prisma.InputJsonValue,
      payload:  dto.payload,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'COUNCIL_CREATED', entityType: 'DecisionCouncil', entityId: row.id,
    payload: { topic: dto.topic, agents: dto.agentIds.length },
  });
  return row;
}

export interface SubmitVoteDto {
  voterId:    string;
  voterKind:  'HUMAN' | 'AGENT';
  vote:       CouncilVoteType;
  confidence?: number;
  rationale?: string;
}

export async function submitVote(actor: CouncilActor, councilId: string, dto: SubmitVoteDto): Promise<{ council: DecisionCouncil; vote: CouncilVote }> {
  const council = await prisma.decisionCouncil.findUnique({ where: { id: councilId } });
  if (!council)                                                        throw new NotFoundError('DecisionCouncil');
  if (council.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  if (council.status === 'CLOSED') throw new BadRequestError('Council closed');

  // Persist vote (upsert keeps single vote per voterId).
  const vote = await prisma.councilVote.upsert({
    where:  { councilId_voterId: { councilId, voterId: dto.voterId } },
    create: { councilId, voterId: dto.voterId, voterKind: dto.voterKind, vote: dto.vote, confidence: dto.confidence ?? 0.5, rationale: dto.rationale ?? null },
    update: { vote: dto.vote, confidence: dto.confidence ?? 0.5, rationale: dto.rationale ?? null },
  });

  // Recompute consensus deterministically (sorted by voterId).
  const updated = await recomputeConsensus(councilId);
  return { council: updated, vote };
}

export async function closeCouncil(actor: CouncilActor, councilId: string): Promise<DecisionCouncil> {
  const c = await prisma.decisionCouncil.findUnique({ where: { id: councilId } });
  if (!c)                                                       throw new NotFoundError('DecisionCouncil');
  if (c.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  if (c.status === 'CLOSED') return c;
  const updated = await prisma.decisionCouncil.update({ where: { id: councilId }, data: { status: 'CLOSED', closedAt: new Date() } });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'COUNCIL_CLOSED', entityType: 'DecisionCouncil', entityId: councilId,
    payload: { consensusScore: c.consensusScore, conflictCount: c.conflictCount },
  });
  return updated;
}

/** Deterministic consensus: votes sorted by voterId, then folded. */
async function recomputeConsensus(councilId: string): Promise<DecisionCouncil> {
  const votes = await prisma.councilVote.findMany({ where: { councilId }, orderBy: { voterId: 'asc' } });
  let approvals = 0, rejections = 0, abstentions = 0;
  let confSum = 0;
  for (const v of votes) {
    if (v.vote === 'APPROVE') approvals++;
    else if (v.vote === 'REJECT') rejections++;
    else                          abstentions++;
    confSum += v.confidence;
  }
  const total = votes.length;
  const meanConf = total === 0 ? 0 : confSum / total;
  // consensus: 1 = unanimous approval, 0 = even split / rejection
  const net = total === 0 ? 0 : (approvals - rejections) / total;
  const consensusScore = Number((Math.max(-1, Math.min(1, net)) * meanConf).toFixed(4));
  const conflictCount = Math.min(approvals, rejections);
  return prisma.decisionCouncil.update({
    where: { id: councilId },
    data: {
      votesCount:       total,
      approvalsCount:   approvals,
      rejectionsCount:  rejections,
      abstentionsCount: abstentions,
      consensusScore,
      conflictCount,
      status:           total > 0 ? 'VOTING' : 'OPEN',
    },
  });
}

export async function listCouncils(actor: CouncilActor, opts: { status?: CouncilStatus; limit?: number } = {}) {
  return prisma.decisionCouncil.findMany({
    where: { clubId: actor.clubId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 50, 500),
  });
}

export async function getCouncil(actor: CouncilActor, id: string): Promise<{ council: DecisionCouncil; votes: CouncilVote[] }> {
  const council = await prisma.decisionCouncil.findUnique({ where: { id } });
  if (!council)                                                        throw new NotFoundError('DecisionCouncil');
  if (council.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  const votes = await prisma.councilVote.findMany({ where: { councilId: id }, orderBy: { voterId: 'asc' } });
  return { council, votes };
}
