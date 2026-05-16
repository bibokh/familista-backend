// Familista — AI Decision Engine
// File location: src/services/ai-player-decisions.service.ts
//
// The 7 player decisions. Each wires together: subject id → feature extraction
// → deterministic scoring → orchestrator (model resolution, narrative,
// persistence, audit, return).

import { prisma } from '../lib/prisma';
import { NotFoundError } from '../utils/errors';
import { extractPlayerFeatures, extractMatchFeatures } from './ai-feature-extraction.service';
import {
  scoreInjuryRisk,
  scorePlayerGrowth,
  scoreTalentDetection,
  scoreFatigue,
  scoreTransferRecommendation,
  scoreTrainingOptimization,
  scoreLineup,
} from '../lib/ai-scoring.lib';
import { orchestrate } from './ai-orchestrator.service';
import { getActiveModel } from './ai-model-registry.service';
import type {
  AIActor,
  DecisionResult,
  PlayerFeatures,
} from '../types/ai-engine.types';

type CallOptions = {
  useLlm?: boolean;
  persist?: boolean;
  cacheTtlSec?: number;
};

async function scopeForPlayer(playerId: string) {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: { clubId: true, club: { select: { franchiseUnitId: true as never } as never } },
  }).catch(() => null);
  if (!player) throw new NotFoundError('Player not found');
  const franchiseUnitId =
    (player.club as unknown as { franchiseUnitId?: string | null } | null | undefined)?.franchiseUnitId ?? null;
  return { clubId: player.clubId, franchiseUnitId };
}

async function modelParams(domain: 'PLAYER', decisionType: PlayerDecisionType) {
  const m = await getActiveModel(domain, decisionType);
  return (m?.parameters as Record<string, unknown> | undefined) ?? undefined;
}

type PlayerDecisionType =
  | 'INJURY_RISK'
  | 'PLAYER_GROWTH'
  | 'TALENT_DETECTION'
  | 'FATIGUE_PREDICTION'
  | 'TRANSFER_RECOMMENDATION'
  | 'TRAINING_OPTIMIZATION'
  | 'LINEUP_RECOMMENDATION';

export async function predictInjuryRisk(
  actor: AIActor,
  playerId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<PlayerFeatures>> {
  const features = await extractPlayerFeatures(playerId);
  const scope = await scopeForPlayer(playerId);
  const params = await modelParams('PLAYER', 'INJURY_RISK');
  const deterministic = scoreInjuryRisk(features, params);

  return await orchestrate<PlayerFeatures>(actor, {
    domain: 'PLAYER',
    decisionType: 'INJURY_RISK',
    subject: { type: 'Player', id: playerId },
    features,
    deterministic,
    scopeContext: scope,
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 6 * 60 * 60 },
  });
}

export async function analyzePlayerGrowth(
  actor: AIActor,
  playerId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<PlayerFeatures>> {
  const features = await extractPlayerFeatures(playerId);
  const scope = await scopeForPlayer(playerId);
  const params = await modelParams('PLAYER', 'PLAYER_GROWTH');
  const deterministic = scorePlayerGrowth(features, params);

  return await orchestrate<PlayerFeatures>(actor, {
    domain: 'PLAYER',
    decisionType: 'PLAYER_GROWTH',
    subject: { type: 'Player', id: playerId },
    features,
    deterministic,
    scopeContext: scope,
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 24 * 60 * 60 },
  });
}

export async function detectTalent(
  actor: AIActor,
  playerId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<PlayerFeatures>> {
  const features = await extractPlayerFeatures(playerId);
  const scope = await scopeForPlayer(playerId);
  const params = await modelParams('PLAYER', 'TALENT_DETECTION');
  const deterministic = scoreTalentDetection(features, params);

  return await orchestrate<PlayerFeatures>(actor, {
    domain: 'PLAYER',
    decisionType: 'TALENT_DETECTION',
    subject: { type: 'Player', id: playerId },
    features,
    deterministic,
    scopeContext: scope,
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 7 * 24 * 60 * 60 },
  });
}

export async function predictFatigue(
  actor: AIActor,
  playerId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<PlayerFeatures>> {
  const features = await extractPlayerFeatures(playerId);
  const scope = await scopeForPlayer(playerId);
  const params = await modelParams('PLAYER', 'FATIGUE_PREDICTION');
  const deterministic = scoreFatigue(features, params);

  return await orchestrate<PlayerFeatures>(actor, {
    domain: 'PLAYER',
    decisionType: 'FATIGUE_PREDICTION',
    subject: { type: 'Player', id: playerId },
    features,
    deterministic,
    scopeContext: scope,
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 2 * 60 * 60 },
  });
}

export async function recommendTransfer(
  actor: AIActor,
  playerId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<PlayerFeatures>> {
  const features = await extractPlayerFeatures(playerId);
  const scope = await scopeForPlayer(playerId);
  const params = await modelParams('PLAYER', 'TRANSFER_RECOMMENDATION');
  const deterministic = scoreTransferRecommendation(features, params);

  return await orchestrate<PlayerFeatures>(actor, {
    domain: 'PLAYER',
    decisionType: 'TRANSFER_RECOMMENDATION',
    subject: { type: 'Player', id: playerId },
    features,
    deterministic,
    scopeContext: scope,
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 24 * 60 * 60 },
  });
}

export async function optimizeTraining(
  actor: AIActor,
  playerId: string,
  opts: CallOptions = {},
): Promise<DecisionResult<PlayerFeatures>> {
  const features = await extractPlayerFeatures(playerId);
  const scope = await scopeForPlayer(playerId);
  const params = await modelParams('PLAYER', 'TRAINING_OPTIMIZATION');
  const deterministic = scoreTrainingOptimization(features, params);

  return await orchestrate<PlayerFeatures>(actor, {
    domain: 'PLAYER',
    decisionType: 'TRAINING_OPTIMIZATION',
    subject: { type: 'Player', id: playerId },
    features,
    deterministic,
    scopeContext: scope,
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 24 * 60 * 60 },
  });
}

export async function recommendLineup(
  actor: AIActor,
  matchId: string,
  opts: CallOptions = {},
): Promise<DecisionResult> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: { clubId: true } });
  if (!match) throw new NotFoundError('Match not found');

  const players = await prisma.player.findMany({ where: { clubId: match.clubId }, select: { id: true } });
  const matchFeatures = await extractMatchFeatures(matchId);
  const playerFeatureList = await Promise.all(
    players.map(async (p) => ({ ...(await extractPlayerFeatures(p.id)), matchId })),
  );

  const params = await modelParams('PLAYER', 'LINEUP_RECOMMENDATION');
  const deterministic = scoreLineup(playerFeatureList, matchFeatures, params);

  const aggregateFeatures = {
    matchId,
    clubId: match.clubId,
    squadSize: playerFeatureList.length,
    eligibleCount: playerFeatureList.filter((p) => !p.isInjured && p.condition >= 65).length,
    avgRating:
      playerFeatureList.length > 0
        ? playerFeatureList.reduce((s, p) => s + p.overallRating, 0) / playerFeatureList.length
        : 0,
    daysToMatch: matchFeatures.daysToMatch,
    isHome: matchFeatures.isHome,
  };

  return await orchestrate(actor, {
    domain: 'PLAYER',
    decisionType: 'LINEUP_RECOMMENDATION',
    subject: { type: 'Match', id: matchId },
    features: aggregateFeatures,
    deterministic,
    scopeContext: { clubId: match.clubId },
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 24 * 60 * 60 },
  });
}
