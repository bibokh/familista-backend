// Familista — AI Decision Engine
// File location: src/services/ai-coach-decisions.service.ts
//
// The 6 coach decisions. All decisions are scoped to a Match (tactical,
// formation, opponent, prep, substitution) or a Club (training plan).

import { prisma } from '../lib/prisma';
import { NotFoundError } from '../utils/errors';
import { extractPlayerFeatures, extractMatchFeatures } from './ai-feature-extraction.service';
import {
  scoreTactical,
  scoreFormation,
  scoreOpponent,
  scoreMatchPreparation,
  scoreSubstitution,
  scoreTrainingPlan,
} from '../lib/ai-scoring.lib';
import { orchestrate } from './ai-orchestrator.service';
import { getActiveModel } from './ai-model-registry.service';
import type { AIActor, DecisionResult } from '../types/ai-engine.types';

type CoachDecisionType =
  | 'TACTICAL_RECOMMENDATION'
  | 'FORMATION_OPTIMIZATION'
  | 'OPPONENT_ANALYSIS'
  | 'MATCH_PREPARATION'
  | 'SUBSTITUTION_RECOMMENDATION'
  | 'TRAINING_PLAN_GENERATION';

type CallOptions = { useLlm?: boolean; persist?: boolean; cacheTtlSec?: number };

async function modelParams(decisionType: CoachDecisionType) {
  const m = await getActiveModel('COACH', decisionType);
  return (m?.parameters as Record<string, unknown> | undefined) ?? undefined;
}

async function loadSquad(clubId: string) {
  const players = await prisma.player.findMany({ where: { clubId }, select: { id: true } });
  return await Promise.all(players.map((p) => extractPlayerFeatures(p.id)));
}

async function clubFromMatch(matchId: string): Promise<{ clubId: string; franchiseUnitId: string | null }> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { clubId: true, club: { select: { franchiseUnitId: true as never } as never } },
  });
  if (!match) throw new NotFoundError('Match not found');
  const fuId =
    (match.club as unknown as { franchiseUnitId?: string | null } | null | undefined)?.franchiseUnitId ?? null;
  return { clubId: match.clubId, franchiseUnitId: fuId };
}

export async function recommendTactics(
  actor: AIActor,
  matchId: string,
  opts: CallOptions = {},
): Promise<DecisionResult> {
  const scope = await clubFromMatch(matchId);
  const squad = await loadSquad(scope.clubId);
  const matchFeatures = await extractMatchFeatures(matchId);
  const deterministic = scoreTactical(squad, matchFeatures, await modelParams('TACTICAL_RECOMMENDATION'));

  return await orchestrate(actor, {
    domain: 'COACH',
    decisionType: 'TACTICAL_RECOMMENDATION',
    subject: { type: 'Match', id: matchId },
    features: { matchId, opponentName: matchFeatures.opponentName, isHome: matchFeatures.isHome, squadSize: squad.length, recentForm: matchFeatures.recentResultsForm },
    deterministic,
    scopeContext: scope,
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 12 * 60 * 60 },
  });
}

export async function optimizeFormation(
  actor: AIActor,
  matchId: string,
  opts: CallOptions = {},
): Promise<DecisionResult> {
  const scope = await clubFromMatch(matchId);
  const squad = await loadSquad(scope.clubId);
  const matchFeatures = await extractMatchFeatures(matchId);
  const deterministic = scoreFormation(squad, matchFeatures, await modelParams('FORMATION_OPTIMIZATION'));

  return await orchestrate(actor, {
    domain: 'COACH',
    decisionType: 'FORMATION_OPTIMIZATION',
    subject: { type: 'Match', id: matchId },
    features: { matchId, squadSize: squad.length },
    deterministic,
    scopeContext: scope,
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 12 * 60 * 60 },
  });
}

export async function analyzeOpponent(
  actor: AIActor,
  matchId: string,
  opts: CallOptions = {},
): Promise<DecisionResult> {
  const scope = await clubFromMatch(matchId);
  const matchFeatures = await extractMatchFeatures(matchId);
  const deterministic = scoreOpponent(matchFeatures, await modelParams('OPPONENT_ANALYSIS'));

  return await orchestrate(actor, {
    domain: 'COACH',
    decisionType: 'OPPONENT_ANALYSIS',
    subject: { type: 'Match', id: matchId },
    features: { matchId, opponentName: matchFeatures.opponentName, isHome: matchFeatures.isHome, daysToMatch: matchFeatures.daysToMatch, recentForm: matchFeatures.recentResultsForm },
    deterministic,
    scopeContext: scope,
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 12 * 60 * 60 },
  });
}

export async function prepareMatch(
  actor: AIActor,
  matchId: string,
  opts: CallOptions = {},
): Promise<DecisionResult> {
  const scope = await clubFromMatch(matchId);
  const squad = await loadSquad(scope.clubId);
  const matchFeatures = await extractMatchFeatures(matchId);
  const deterministic = scoreMatchPreparation(squad, matchFeatures, await modelParams('MATCH_PREPARATION'));

  return await orchestrate(actor, {
    domain: 'COACH',
    decisionType: 'MATCH_PREPARATION',
    subject: { type: 'Match', id: matchId },
    features: {
      matchId,
      squadSize: squad.length,
      injured: squad.filter((p) => p.isInjured).length,
      fatigued: squad.filter((p) => p.condition < 70).length,
      daysToMatch: matchFeatures.daysToMatch,
    },
    deterministic,
    scopeContext: scope,
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 12 * 60 * 60 },
  });
}

export async function recommendSubstitution(
  actor: AIActor,
  matchId: string,
  opts: CallOptions = {},
): Promise<DecisionResult> {
  const scope = await clubFromMatch(matchId);
  const squad = await loadSquad(scope.clubId);
  const deterministic = scoreSubstitution(squad, await modelParams('SUBSTITUTION_RECOMMENDATION'));

  return await orchestrate(actor, {
    domain: 'COACH',
    decisionType: 'SUBSTITUTION_RECOMMENDATION',
    subject: { type: 'Match', id: matchId },
    features: { matchId, squadSize: squad.length, minCondition: Math.min(...squad.map((p) => p.condition)) },
    deterministic,
    scopeContext: scope,
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 60 * 60 },
  });
}

export async function generateTrainingPlan(
  actor: AIActor,
  clubId: string,
  opts: CallOptions = {},
): Promise<DecisionResult> {
  const squad = await loadSquad(clubId);
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { franchiseUnitId: true as never },
  });
  const fuId =
    (club as unknown as { franchiseUnitId?: string | null } | null | undefined)?.franchiseUnitId ?? null;
  const deterministic = scoreTrainingPlan(squad, await modelParams('TRAINING_PLAN_GENERATION'));

  return await orchestrate(actor, {
    domain: 'COACH',
    decisionType: 'TRAINING_PLAN_GENERATION',
    subject: { type: 'Club', id: clubId },
    features: {
      clubId,
      squadSize: squad.length,
      avgCondition: squad.length > 0 ? squad.reduce((s, p) => s + p.condition, 0) / squad.length : 0,
      injured: squad.filter((p) => p.isInjured).length,
    },
    deterministic,
    scopeContext: { clubId, franchiseUnitId: fuId },
    options: { useLlm: opts.useLlm, persist: opts.persist, cacheTtlSec: opts.cacheTtlSec ?? 24 * 60 * 60 },
  });
}
