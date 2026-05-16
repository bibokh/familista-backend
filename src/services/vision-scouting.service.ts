// Familista — Vision Intelligence Engine
// File location: src/services/vision-scouting.service.ts
//
// Scouting outputs derived from vision data:
//   • OPPONENT_BRIEF      — tactical patterns observed against an opponent
//   • TALENT_SCAN          — individual player profile from a match / training
//   • RECRUITMENT_BRIEF    — synthesis across multiple analyses for a target
//   • ACADEMY_PROSPECT     — youth-focused profile
//   • MATCH_REPORT         — comprehensive post-match deliverable
//
// Each report is grounded in the persisted AnalyticsResult rows so it is
// fully auditable: the underlying numbers + analysis run IDs are part of the
// payload. The natural-language summary is deterministic — built from the
// scored analytics, not invented — keeping the report board-safe.

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import type { ScoutingKind, ScoutingReport } from '@prisma/client';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { writeVisionAudit } from './vision-audit.service';
import type { GenerateScoutingInput } from '../utils/vision.validators';
import type { VisionActor } from '../types/vision.types';

function round2(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

type AnalyticsSummary = {
  formationHome: string | null;
  formationAway: string | null;
  possessionHome: number | null;
  possessionAway: number | null;
  buildUpPatternsHome: string[];
  buildUpPatternsAway: string[];
  shapeCompactnessHome: number | null;
  shapeCompactnessAway: number | null;
  transitionSpeedHomeMs: number | null;
  transitionSpeedAwayMs: number | null;
  passAccuracyHome: number | null;
  passAccuracyAway: number | null;
  pressingEvents: number;
};

async function summarizeAnalyses(matchId: string, analysisId?: string | null): Promise<AnalyticsSummary> {
  const where = analysisId ? { analysisId } : { matchId };
  const rows = await prisma.analyticsResult.findMany({ where, orderBy: { createdAt: 'desc' } });

  const pickLatest = <T>(kind: string, side: 'HOME' | 'AWAY' | null, mapper: (payload: unknown) => T | null): T | null => {
    const r = rows.find((x) => x.kind === kind && (side ? x.teamSide === side : true));
    return r ? mapper(r.payload) : null;
  };

  const possession = rows.find((r) => r.kind === 'POSSESSION_BLOCK');
  const possessionPayload = possession?.payload as { homeSeconds?: number; awaySeconds?: number; contestedSeconds?: number } | null;

  const passHome = rows.find((r) => r.kind === 'PASSING_NETWORK' && r.teamSide === 'HOME');
  const passAway = rows.find((r) => r.kind === 'PASSING_NETWORK' && r.teamSide === 'AWAY');

  const shapeHome = pickLatest('SHAPE_COMPACTNESS', 'HOME', (p) => (p as { avgPairwiseDistance?: number })?.avgPairwiseDistance ?? null);
  const shapeAway = pickLatest('SHAPE_COMPACTNESS', 'AWAY', (p) => (p as { avgPairwiseDistance?: number })?.avgPairwiseDistance ?? null);

  const transitionHome = pickLatest('TRANSITION_SPEED', 'HOME', (p) => (p as { avgTransitionMs?: number })?.avgTransitionMs ?? null);
  const transitionAway = pickLatest('TRANSITION_SPEED', 'AWAY', (p) => (p as { avgTransitionMs?: number })?.avgTransitionMs ?? null);

  const buildHome = pickLatest('BUILD_UP_PATTERN', 'HOME', (p) => (p as { patterns?: string[] })?.patterns ?? []);
  const buildAway = pickLatest('BUILD_UP_PATTERN', 'AWAY', (p) => (p as { patterns?: string[] })?.patterns ?? []);

  return {
    formationHome: pickLatest('FORMATION_SNAPSHOT', 'HOME', (p) => (p as { formation?: string })?.formation ?? null),
    formationAway: pickLatest('FORMATION_SNAPSHOT', 'AWAY', (p) => (p as { formation?: string })?.formation ?? null),
    possessionHome: possessionPayload?.homeSeconds ?? null,
    possessionAway: possessionPayload?.awaySeconds ?? null,
    buildUpPatternsHome: buildHome ?? [],
    buildUpPatternsAway: buildAway ?? [],
    shapeCompactnessHome: shapeHome,
    shapeCompactnessAway: shapeAway,
    transitionSpeedHomeMs: transitionHome,
    transitionSpeedAwayMs: transitionAway,
    passAccuracyHome: (passHome?.payload as { passAccuracy?: number } | null)?.passAccuracy ?? null,
    passAccuracyAway: (passAway?.payload as { passAccuracy?: number } | null)?.passAccuracy ?? null,
    pressingEvents: rows.filter((r) => r.kind === 'PRESSING_EVENT').length,
  };
}

async function summarizePlayer(playerId: string, analysisId?: string | null): Promise<{
  sprintProfile: unknown | null;
  technicalExecution: unknown[];
  positionCentroid: { x: number; y: number } | null;
}> {
  const where = analysisId ? { analysisId, playerId } : { playerId };
  const analytics = await prisma.analyticsResult.findMany({ where });
  const sprintProfile = analytics.find((r) => r.kind === 'SPRINT_PROFILE')?.payload ?? null;
  const technicalExecution = analytics.filter((r) => r.kind === 'TECHNICAL_EXECUTION').map((r) => r.payload);

  const tracks = await prisma.playerTrack.findMany({
    where: { ...(analysisId ? { analysisId } : {}), playerId },
    select: { avgX: true, avgY: true },
  });
  let positionCentroid: { x: number; y: number } | null = null;
  if (tracks.length > 0) {
    positionCentroid = {
      x: round2(tracks.reduce((s, t) => s + t.avgX, 0) / tracks.length) ?? 0,
      y: round2(tracks.reduce((s, t) => s + t.avgY, 0) / tracks.length) ?? 0,
    };
  }

  return { sprintProfile, technicalExecution, positionCentroid };
}

function narrateOpponent(s: AnalyticsSummary, opponentName: string | null): string {
  const parts: string[] = [];
  if (s.formationAway) parts.push(`Default shape: ${s.formationAway}.`);
  if (s.passAccuracyAway != null) parts.push(`Pass accuracy: ${Math.round(s.passAccuracyAway * 100)}%.`);
  if (s.shapeCompactnessAway != null) parts.push(`Compactness ~${s.shapeCompactnessAway} units.`);
  if (s.transitionSpeedAwayMs != null) parts.push(`Avg transition into final third: ${Math.round(s.transitionSpeedAwayMs / 1000)}s.`);
  if (s.buildUpPatternsAway.length > 0) parts.push(`Dominant build-up: ${s.buildUpPatternsAway.join(', ')}.`);
  if (s.pressingEvents > 0) parts.push(`${s.pressingEvents} pressing trigger(s) recorded.`);
  return `${opponentName ?? 'Opponent'} brief — ${parts.length > 0 ? parts.join(' ') : 'No quantitative signal extracted yet.'}`;
}

function narrateTalent(player: Awaited<ReturnType<typeof summarizePlayer>>, playerId: string): string {
  const parts: string[] = [];
  const sp = player.sprintProfile as { sprintCount?: number; maxSprintSpeedKmh?: number; totalSprintDistance?: number } | null;
  if (sp) {
    parts.push(`${sp.sprintCount ?? 0} sprints @ peak ${sp.maxSprintSpeedKmh ?? 0} km/h over ${sp.totalSprintDistance ?? 0} m.`);
  }
  if (player.technicalExecution.length > 0) {
    const lines = player.technicalExecution
      .map((te) => {
        const x = te as { metric?: string; successRate?: number; attempts?: number } | null;
        if (!x?.metric) return null;
        return `${x.metric} ${Math.round((x.successRate ?? 0) * 100)}% (${x.attempts ?? 0})`;
      })
      .filter((s): s is string => !!s);
    if (lines.length > 0) parts.push(`Technical: ${lines.join(', ')}.`);
  }
  if (player.positionCentroid) {
    parts.push(`Avg position: (${player.positionCentroid.x}, ${player.positionCentroid.y}).`);
  }
  return parts.length > 0
    ? `Player ${playerId} — ${parts.join(' ')}`
    : `Player ${playerId} — insufficient analytics for a quantitative talent summary.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function generateScoutingReport(
  actor: VisionActor,
  input: GenerateScoutingInput,
): Promise<ScoutingReport> {
  if (input.kind === 'OPPONENT_BRIEF' && !input.matchId) {
    throw new BadRequestError('OPPONENT_BRIEF requires a matchId');
  }
  if (
    (input.kind === 'TALENT_SCAN' || input.kind === 'RECRUITMENT_BRIEF' || input.kind === 'ACADEMY_PROSPECT') &&
    !input.targetPlayerId
  ) {
    throw new BadRequestError(`${input.kind} requires a targetPlayerId`);
  }

  let summary = '';
  let payload: Record<string, unknown> = {};
  let confidence = 0.7;

  if (input.matchId) {
    const ms = await summarizeAnalyses(input.matchId, input.analysisId);
    if (input.kind === 'OPPONENT_BRIEF') {
      summary = narrateOpponent(ms, input.opponentName ?? null);
      payload = { matchSummary: ms, opponentName: input.opponentName ?? null };
      confidence = ms.formationAway && ms.possessionAway != null ? 0.8 : 0.55;
    } else if (input.kind === 'MATCH_REPORT') {
      summary = `Match report ${input.matchId} — Home ${ms.formationHome ?? 'unknown'} vs Away ${ms.formationAway ?? 'unknown'}. Possession ${ms.possessionHome ?? 0}s / ${ms.possessionAway ?? 0}s. Pressing events: ${ms.pressingEvents}.`;
      payload = { matchSummary: ms };
      confidence = 0.85;
    }
  }

  if (input.targetPlayerId) {
    const ps = await summarizePlayer(input.targetPlayerId, input.analysisId);
    const playerNarrative = narrateTalent(ps, input.targetPlayerId);
    summary = summary ? `${summary}\n\n${playerNarrative}` : playerNarrative;
    payload.playerSummary = ps;
    confidence = Math.max(confidence, ps.technicalExecution.length > 0 ? 0.7 : 0.55);
  }

  if (input.notes) {
    summary += `\n\nAnalyst notes: ${input.notes}`;
  }

  const report = await prisma.scoutingReport.create({
    data: {
      kind: input.kind as ScoutingKind,
      matchId: input.matchId ?? null,
      opponentName: input.opponentName ?? null,
      targetPlayerId: input.targetPlayerId ?? null,
      targetClubId: input.targetClubId ?? null,
      title: input.title,
      summary: summary || 'No quantitative signal extracted yet.',
      payload: payload as Prisma.InputJsonValue,
      confidence,
      generatedFromAnalysisId: input.analysisId ?? null,
      generatedBy: actor.userId,
    },
  });

  await writeVisionAudit({
    analysisId: input.analysisId ?? null,
    matchId: input.matchId ?? null,
    userId: actor.userId,
    action: 'SCOUTING_REPORT_GENERATED',
    category: 'SCOUTING',
    resourceType: 'ScoutingReport',
    resourceId: report.id,
    metadata: { kind: input.kind, targetPlayerId: input.targetPlayerId ?? null, opponentName: input.opponentName ?? null },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return report;
}

export async function listScoutingReports(opts: {
  kind?: ScoutingKind;
  matchId?: string;
  targetPlayerId?: string;
  targetClubId?: string;
  cursor?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = await prisma.scoutingReport.findMany({
    where: {
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.matchId ? { matchId: opts.matchId } : {}),
      ...(opts.targetPlayerId ? { targetPlayerId: opts.targetPlayerId } : {}),
      ...(opts.targetClubId ? { targetClubId: opts.targetClubId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });
  const hasMore = items.length > take;
  return { items: items.slice(0, take), nextCursor: hasMore ? items[take - 1].id : null };
}

export async function getScoutingReport(id: string): Promise<ScoutingReport> {
  const report = await prisma.scoutingReport.findUnique({ where: { id } });
  if (!report) throw new NotFoundError('Scouting report not found');
  return report;
}
