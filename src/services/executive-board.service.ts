// Familista — Executive OS · Integration Layer
// File location: src/services/executive-board.service.ts
//
// Board resolutions + voting. Resolutions move through:
//   DRAFT → CIRCULATING → VOTING → (PASSED | FAILED | WITHDRAWN)
//
// Votes carry per-voter weight (configured on ExecutiveAssignment). When the
// running tally meets quorum + passingMajority before the votingClosesAt
// deadline, the resolution is auto-decided. Otherwise it can be tallied
// manually at deadline.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  BoardResolution,
  BoardResolutionStatus,
  BoardVote,
} from '@prisma/client';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../utils/errors';
import { writeExecutiveAudit } from './executive-audit.service';
import type {
  CastVoteInput,
  CreateResolutionInput,
  TransitionResolutionInput,
} from '../utils/executive.validators';
import type { ExecutiveActor } from '../types/executive.types';

const TRANSITIONS: Record<BoardResolutionStatus, ReadonlyArray<BoardResolutionStatus>> = {
  DRAFT:       ['CIRCULATING', 'WITHDRAWN'],
  CIRCULATING: ['VOTING', 'WITHDRAWN'],
  VOTING:      ['PASSED', 'FAILED', 'WITHDRAWN'],
  PASSED:      [],
  FAILED:      [],
  WITHDRAWN:   [],
};

function assertTransition(from: BoardResolutionStatus, to: BoardResolutionStatus): void {
  if (from === to) return;
  if (!TRANSITIONS[from].includes(to)) {
    throw new BadRequestError(`Resolution transition ${from} → ${to} not allowed`);
  }
}

export async function createResolution(
  actor: ExecutiveActor,
  input: CreateResolutionInput,
): Promise<BoardResolution> {
  const created = await prisma.boardResolution.create({
    data: {
      title: input.title,
      resolutionText: input.resolutionText,
      workflowId: input.workflowId ?? null,
      quorumRequired: input.quorumRequired ?? 3,
      passingMajority: input.passingMajority ?? 0.5,
      votingClosesAt: input.votingClosesAt ? new Date(input.votingClosesAt) : null,
      metadata:
        input.metadata === undefined || input.metadata === null
          ? undefined
          : (input.metadata as Prisma.InputJsonValue),
      initiatedBy: actor.userId,
    },
  });

  await writeExecutiveAudit({
    resolutionId: created.id,
    workflowId: input.workflowId ?? null,
    userId: actor.userId,
    action: 'RESOLUTION_CREATED',
    category: 'BOARD',
    resourceType: 'BoardResolution',
    resourceId: created.id,
    metadata: { title: created.title, quorumRequired: created.quorumRequired },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return created;
}

export async function transitionResolution(
  actor: ExecutiveActor,
  id: string,
  input: TransitionResolutionInput,
): Promise<BoardResolution> {
  const existing = await prisma.boardResolution.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Resolution not found');
  assertTransition(existing.status, input.status);

  const updated = await prisma.boardResolution.update({
    where: { id },
    data: {
      status: input.status,
      circulationOpenedAt:
        input.status === 'CIRCULATING' && !existing.circulationOpenedAt ? new Date() : existing.circulationOpenedAt,
      votingOpenedAt: input.status === 'VOTING' && !existing.votingOpenedAt ? new Date() : existing.votingOpenedAt,
      decidedAt:
        input.status === 'PASSED' || input.status === 'FAILED'
          ? new Date()
          : existing.decidedAt,
      effectiveAt: input.effectiveAt ? new Date(input.effectiveAt) : existing.effectiveAt,
      withdrawnAt: input.status === 'WITHDRAWN' ? new Date() : existing.withdrawnAt,
      withdrawnReason: input.status === 'WITHDRAWN' ? input.notes ?? null : existing.withdrawnReason,
    },
  });

  await writeExecutiveAudit({
    resolutionId: id,
    userId: actor.userId,
    action: `RESOLUTION_${input.status}`,
    category: 'BOARD',
    resourceType: 'BoardResolution',
    resourceId: id,
    metadata: { from: existing.status, to: input.status, notes: input.notes },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    result: input.status === 'FAILED' || input.status === 'WITHDRAWN' ? 'REJECTED' : 'SUCCESS',
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────────────────────────

export async function castVote(
  actor: ExecutiveActor,
  resolutionId: string,
  input: CastVoteInput,
): Promise<{ vote: BoardVote; resolution: BoardResolution }> {
  if (!actor.scope.executiveRole) throw new BadRequestError('Actor has no executive role');

  const result = await prisma.$transaction(async (tx) => {
    const resolution = await tx.boardResolution.findUnique({ where: { id: resolutionId } });
    if (!resolution) throw new NotFoundError('Resolution not found');
    if (resolution.status !== 'VOTING') {
      throw new BadRequestError(`Cannot vote on a resolution in status ${resolution.status}`);
    }
    if (resolution.votingClosesAt && resolution.votingClosesAt.getTime() < Date.now()) {
      throw new BadRequestError('Voting window has closed');
    }

    const dup = await tx.boardVote.findUnique({
      where: { resolutionId_voterUserId: { resolutionId, voterUserId: actor.userId } },
    });
    if (dup) throw new ConflictError('You have already voted on this resolution');

    const vote = await tx.boardVote.create({
      data: {
        resolutionId,
        voterUserId: actor.userId,
        assignmentId: actor.scope.executiveAssignmentId,
        role: actor.scope.executiveRole!,
        decision: input.decision,
        weight: actor.scope.voteWeight,
        rationale: input.rationale ?? null,
        signatureRef: input.signatureRef ?? null,
      },
    });

    // Recalculate tallies from all votes (denormalised on resolution)
    const allVotes = await tx.boardVote.findMany({ where: { resolutionId } });
    let votesFor = 0;
    let votesAgainst = 0;
    let votesAbstain = 0;
    let totalWeight = 0;
    for (const v of allVotes) {
      if (v.decision === 'FOR') votesFor += v.weight;
      else if (v.decision === 'AGAINST') votesAgainst += v.weight;
      else votesAbstain += v.weight;
      totalWeight += v.weight;
    }

    const voterCount = allVotes.length;
    const decisiveDenom = votesFor + votesAgainst;
    const forShare = decisiveDenom > 0 ? votesFor / decisiveDenom : 0;

    let newStatus: BoardResolutionStatus = resolution.status;
    if (voterCount >= resolution.quorumRequired) {
      if (forShare >= resolution.passingMajority) newStatus = 'PASSED';
      else if (1 - forShare > 1 - resolution.passingMajority) {
        // Mathematically the resolution cannot pass any more
        const remainingPossibleVotes = Math.max(0, resolution.quorumRequired - voterCount);
        const bestPossibleFor = votesFor + remainingPossibleVotes;
        const bestPossibleDenom = decisiveDenom + remainingPossibleVotes;
        const bestPossibleForShare = bestPossibleDenom > 0 ? bestPossibleFor / bestPossibleDenom : 0;
        if (bestPossibleForShare < resolution.passingMajority) newStatus = 'FAILED';
      }
    }

    const updatedResolution = await tx.boardResolution.update({
      where: { id: resolutionId },
      data: {
        votesFor: Math.round(votesFor * 100) / 100,
        votesAgainst: Math.round(votesAgainst * 100) / 100,
        votesAbstain: Math.round(votesAbstain * 100) / 100,
        totalWeight: Math.round(totalWeight * 100) / 100,
        status: newStatus,
        decidedAt: newStatus === 'PASSED' || newStatus === 'FAILED' ? new Date() : resolution.decidedAt,
        effectiveAt: newStatus === 'PASSED' && !resolution.effectiveAt ? new Date() : resolution.effectiveAt,
      },
    });

    return { vote, resolution: updatedResolution };
  });

  await writeExecutiveAudit({
    resolutionId,
    userId: actor.userId,
    action: 'VOTE_CAST',
    category: 'BOARD',
    resourceType: 'BoardVote',
    resourceId: result.vote.id,
    metadata: { decision: input.decision, weight: actor.scope.voteWeight, role: actor.scope.executiveRole },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return result;
}

export async function tallyAndClose(actor: ExecutiveActor, resolutionId: string): Promise<BoardResolution> {
  const resolution = await prisma.boardResolution.findUnique({
    where: { id: resolutionId },
    include: { votes: true },
  });
  if (!resolution) throw new NotFoundError('Resolution not found');
  if (resolution.status !== 'VOTING') throw new BadRequestError('Resolution must be in VOTING status');

  const decisiveDenom = resolution.votesFor + resolution.votesAgainst;
  const forShare = decisiveDenom > 0 ? resolution.votesFor / decisiveDenom : 0;
  const voterCount = resolution.votes.length;
  const quorumMet = voterCount >= resolution.quorumRequired;
  const passed = quorumMet && forShare >= resolution.passingMajority;

  const updated = await prisma.boardResolution.update({
    where: { id: resolutionId },
    data: {
      status: passed ? 'PASSED' : 'FAILED',
      decidedAt: new Date(),
      effectiveAt: passed && !resolution.effectiveAt ? new Date() : resolution.effectiveAt,
    },
  });

  await writeExecutiveAudit({
    resolutionId,
    userId: actor.userId,
    action: passed ? 'RESOLUTION_PASSED' : 'RESOLUTION_FAILED',
    category: 'BOARD',
    resourceType: 'BoardResolution',
    resourceId: resolutionId,
    metadata: { votesFor: resolution.votesFor, votesAgainst: resolution.votesAgainst, voterCount, quorumMet },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    result: passed ? 'SUCCESS' : 'REJECTED',
  });

  return updated;
}

export async function listResolutions(opts: {
  status?: BoardResolutionStatus;
  workflowId?: string;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = await prisma.boardResolution.findMany({
    where: {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.workflowId ? { workflowId: opts.workflowId } : {}),
    },
    include: { _count: { select: { votes: true } } },
    orderBy: [{ createdAt: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function getResolution(id: string) {
  const resolution = await prisma.boardResolution.findUnique({
    where: { id },
    include: { votes: { orderBy: { votedAt: 'desc' } } },
  });
  if (!resolution) throw new NotFoundError('Resolution not found');
  return resolution;
}
