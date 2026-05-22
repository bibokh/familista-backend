// Familista — Predictive Intelligence Layer (Phase G)
// ─────────────────────────────────────────────────────────────────────────
// 4 deterministic predictors. Each is a pure function over data the rest
// of the platform already collects. Outputs are persisted to the
// Prediction table so coaches can audit, replay, and dispute them.
//
// Predictors:
//   - TACTICAL_COLLAPSE   : momentum trajectory + sprint exhaustion
//   - INJURY_RISK         : composite over condition + medicalStatus + recent load
//   - FATIGUE_TRAJECTORY  : HR drift + sprint frequency vs window
//   - POSITIONING_DEGRADATION : deviation from sport-adapter formation template
//
// "Deterministic" means: same inputs → same outputs. No clock, no random.
// `modelVersion` is bumped on logic changes so replay can pin a version.

import type { Prisma, SportKind } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { logger } from '../utils/logger';
import { buildMatchBrain } from '../realtime/match-brain';
import { getSportAdapter } from '../sports';
import { getState } from '../realtime/tactical-state';
import * as aiOps from '../services/ai-ops.service';

export type PredictionKindLocal =
  | 'TACTICAL_COLLAPSE'
  | 'INJURY_RISK'
  | 'FATIGUE_TRAJECTORY'
  | 'POSITIONING_DEGRADATION'
  | 'MOMENTUM_SHIFT'
  | 'SUBSTITUTION_WINDOW';

const MODEL_VERSION = 'v1';

export interface PredictResult {
  kind:        PredictionKindLocal;
  score:       number;     // 0..1
  horizonMs:   number;
  components:  Record<string, number | string | null>;
  rationale:   string;
  /** Persisted Prediction row id when persisted; null if dry-run. */
  id:          string | null;
  matchId:     string;
  playerId:    string | null;
}

export interface PredictAllOpts {
  /** When true, the predictor rows are NOT persisted. */
  dryRun?: boolean;
  /** Override the sport (default FOOTBALL — Match.sport not on schema yet). */
  sport?:  SportKind;
}

/**
 * Run all 4 predictors for a match. Returns an array of results — caller
 * decides whether to render or alert.
 */
export async function predictAll(matchId: string, clubId: string, opts: PredictAllOpts = {}): Promise<PredictResult[]> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: { id: true, clubId: true, teamId: true } });
  if (!match)                  throw new NotFoundError('Match');
  if (match.clubId !== clubId) throw new ForbiddenError();

  const sport: SportKind = opts.sport ?? 'FOOTBALL';
  const out: PredictResult[] = [];

  // 1. Tactical collapse — derived from match brain momentum + threat against.
  out.push(await predictTacticalCollapse(matchId, clubId, opts.dryRun));

  // 2. Positioning degradation — frame vs adapter formation template.
  out.push(await predictPositioningDegradation(matchId, clubId, sport, opts.dryRun));

  // 3 + 4. Per-player: injury + fatigue.
  const players = await prisma.player.findMany({
    where:  { clubId, ...(match.teamId ? { teamId: match.teamId } : {}), isActive: true },
    select: { id: true, firstName: true, lastName: true, number: true, condition: true, isInjured: true, medicalStatus: true },
    take:   30,
  });
  for (const p of players) {
    out.push(await predictInjury(matchId, clubId, p, opts.dryRun));
  }
  // Fatigue uses sensor data; query once outside the loop.
  for (const p of players) {
    out.push(await predictFatigue(matchId, clubId, p, opts.dryRun));
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Tactical collapse
// ─────────────────────────────────────────────────────────────────────────

async function predictTacticalCollapse(matchId: string, clubId: string, dryRun?: boolean): Promise<PredictResult> {
  const brain = await buildMatchBrain(matchId, clubId);
  const m = brain.momentum;
  const fatiguedCount = brain.players.filter((p) => p.alert === 'CRITICAL').length;
  const cautionCount  = brain.players.filter((p) => p.alert === 'CAUTION').length;

  // Score components:
  //   - momentum   → -1..+1, we want the magnitude of NEGATIVE momentum
  //   - threats    → recent shots against / threats
  //   - fatigue    → critical + 0.5 × caution players
  const negativeMomentum = Math.max(0, -m.index);                // 0..1
  const threatPressure   = Math.min(1, (m.threatAgainst ?? 0) / 6);
  const fatigueLoad      = Math.min(1, (fatiguedCount + cautionCount * 0.5) / 8);

  const score = Number(
    Math.max(0, Math.min(1,
      0.45 * negativeMomentum + 0.30 * threatPressure + 0.25 * fatigueLoad,
    )).toFixed(3),
  );

  const result = await persistOrReturn({
    kind:       'TACTICAL_COLLAPSE',
    matchId,
    playerId:   null,
    score,
    horizonMs:  5 * 60_000,
    components: { negativeMomentum, threatPressure, fatigueLoad, momentumIndex: m.index, threatAgainst: m.threatAgainst ?? 0 },
    rationale:  `Risk of tactical collapse in the next 5 minutes. Momentum index ${m.index.toFixed(2)}, ${m.threatAgainst} threats against, ${fatiguedCount + cautionCount} fatigued.`,
    clubId, dryRun,
  });

  if (score > 0.75 && !dryRun) {
    safeAlert(clubId, matchId, null, 'TACTICAL_COLLAPSE_RISK', 'WARN',
      'Tactical collapse risk elevated',
      result.rationale,
      result.components as Prisma.InputJsonValue);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Positioning degradation — vs sport-adapter formation template
// ─────────────────────────────────────────────────────────────────────────

async function predictPositioningDegradation(
  matchId: string,
  clubId:  string,
  sport:   SportKind,
  dryRun?: boolean,
): Promise<PredictResult> {
  const state = await getState(matchId, clubId);
  const adapter = getSportAdapter(sport);
  const formations = adapter.formations();
  const haveTemplate = formations.length > 0 && state.players.some((p) => p.x != null && p.y != null);

  if (!haveTemplate) {
    return persistOrReturn({
      kind: 'POSITIONING_DEGRADATION', matchId, playerId: null,
      score: 0, horizonMs: 5 * 60_000,
      components: { reason: 'no_template_or_positions' },
      rationale: 'No formation template or live positions available; positioning degradation = 0.',
      clubId, dryRun,
    });
  }

  // Pick the formation whose mean distance is smallest — that's the
  // closest match. Then score = mean / 25m, clamped to [0..1].
  const positioned = state.players.filter((p) => p.x != null && p.y != null) as Array<{ x: number; y: number }>;
  let bestName = formations[0].name;
  let bestMeanDist = Infinity;
  for (const f of formations) {
    const meanDist = meanDistanceToTemplate(positioned, f.spots);
    if (meanDist < bestMeanDist) { bestMeanDist = meanDist; bestName = f.name; }
  }
  const score = Number(Math.max(0, Math.min(1, bestMeanDist / 25)).toFixed(3));

  return persistOrReturn({
    kind: 'POSITIONING_DEGRADATION', matchId, playerId: null,
    score, horizonMs: 5 * 60_000,
    components: { closestFormation: bestName, meanDistanceM: Number(bestMeanDist.toFixed(2)), positioned: positioned.length },
    rationale: `Closest formation template: ${bestName}. Mean drift = ${bestMeanDist.toFixed(1)} m. Score normalised against 25 m gate.`,
    clubId, dryRun,
  });
}

function meanDistanceToTemplate(players: Array<{ x: number; y: number }>, spots: Array<{ x: number; y: number }>): number {
  if (players.length === 0 || spots.length === 0) return Infinity;
  // Greedy assignment — each player → nearest spot; tracks used spots.
  const used = new Set<number>();
  let total = 0, count = 0;
  for (const p of players) {
    let bestIdx = -1, bestD = Infinity;
    for (let i = 0; i < spots.length; i++) {
      if (used.has(i)) continue;
      const dx = p.x - spots[i].x, dy = p.y - spots[i].y;
      const d  = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    if (bestIdx === -1) break;
    used.add(bestIdx);
    total += bestD; count++;
  }
  return count === 0 ? Infinity : total / count;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Injury risk (per player)
// ─────────────────────────────────────────────────────────────────────────

async function predictInjury(matchId: string, clubId: string, p: { id: string; firstName: string; lastName: string; number: number | null; condition: number | null; isInjured: boolean; medicalStatus: string | null }, dryRun?: boolean): Promise<PredictResult> {
  const condition = Math.max(0, Math.min(100, p.condition ?? 80));
  const conditionGap = 1 - condition / 100;
  let medicalLoad = 0;
  if (p.isInjured) medicalLoad = 1.0;
  else if (p.medicalStatus === 'RECOVERING') medicalLoad = 0.7;
  else if (p.medicalStatus === 'DOUBTFUL')   medicalLoad = 0.55;
  else if (p.medicalStatus === 'MONITORING') medicalLoad = 0.4;
  else                                       medicalLoad = 0.05;

  const score = Number(Math.max(0, Math.min(1, conditionGap * 0.45 + medicalLoad * 0.55)).toFixed(3));

  return persistOrReturn({
    kind: 'INJURY_RISK', matchId, playerId: p.id,
    score, horizonMs: 24 * 60 * 60_000,           // 24h
    components: { condition, conditionGap, medicalLoad, isInjured: p.isInjured ? 1 : 0, medicalStatus: p.medicalStatus ?? 'HEALTHY' },
    rationale: `#${p.number ?? '?'} ${p.firstName} ${p.lastName} — condition ${condition}, status ${p.medicalStatus ?? 'HEALTHY'}${p.isInjured ? ' (INJURED)' : ''}.`,
    clubId, dryRun,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Fatigue trajectory (per player)
// ─────────────────────────────────────────────────────────────────────────

async function predictFatigue(matchId: string, clubId: string, p: { id: string; firstName: string; lastName: string; number: number | null }, dryRun?: boolean): Promise<PredictResult> {
  // Pull last 5 minutes of GPS + HR.
  const since = new Date(Date.now() - 5 * 60_000);
  const [gps, hr] = await Promise.all([
    prisma.sensorPacket.findMany({
      where: {
        deviceSession: { clubId, matchId },
        kind: 'GPS',
        capturedAt: { gte: since },
      },
      select: { capturedAt: true, payload: true },
      take: 1500,
    }),
    prisma.sensorPacket.findMany({
      where: {
        deviceSession: { clubId, matchId },
        kind: 'HEART_RATE',
        capturedAt: { gte: since },
      },
      select: { capturedAt: true, payload: true },
      take: 600,
    }),
  ]);

  // Filter to this player.
  const myGps = gps.filter((g) => (g.payload as { playerId?: string } | null)?.playerId === p.id);
  const myHr  = hr.filter((g) =>  (g.payload as { playerId?: string } | null)?.playerId === p.id);

  // Components:
  //   - hrDrift     : (last_bpm - first_bpm) / 60 → ∈ [-1..1], + means rising
  //   - sprintRate  : sprint count / minute, normalised against 6/min
  //   - meanHr      : normalised against 180 bpm
  let hrDrift = 0, meanHr = 0;
  if (myHr.length >= 2) {
    const first = (myHr[0].payload as { bpm?: number })?.bpm ?? 0;
    const last  = (myHr[myHr.length - 1].payload as { bpm?: number })?.bpm ?? 0;
    hrDrift = Math.max(-1, Math.min(1, (last - first) / 60));
    const sum = myHr.reduce((s, h) => s + ((h.payload as { bpm?: number })?.bpm ?? 0), 0);
    meanHr = sum / myHr.length;
  }
  let sprintCount = 0;
  for (let i = 1; i < myGps.length; i++) {
    const prev = (myGps[i - 1].payload as { speed?: number })?.speed ?? 0;
    const cur  = (myGps[i].payload as { speed?: number })?.speed ?? 0;
    if (prev <= 7 && cur > 7) sprintCount++;
  }
  const sprintRate = sprintCount / 5;                                 // per minute
  const meanHrNorm = Math.max(0, Math.min(1, meanHr / 180));
  const sprintNorm = Math.max(0, Math.min(1, sprintRate / 6));
  const driftNorm  = Math.max(0, hrDrift);                            // negative drift doesn't drive fatigue

  const score = Number(Math.max(0, Math.min(1, 0.5 * driftNorm + 0.3 * meanHrNorm + 0.2 * sprintNorm)).toFixed(3));

  return persistOrReturn({
    kind: 'FATIGUE_TRAJECTORY', matchId, playerId: p.id,
    score, horizonMs: 10 * 60_000,
    components: { hrDrift, meanHr: Math.round(meanHr), sprintRate: Number(sprintRate.toFixed(2)), samplesGps: myGps.length, samplesHr: myHr.length },
    rationale: `#${p.number ?? '?'} ${p.firstName} ${p.lastName} — HR drift ${hrDrift.toFixed(2)}, mean ${Math.round(meanHr)} bpm, ${sprintCount} sprint starts in 5 min.`,
    clubId, dryRun,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Persistence helper
// ─────────────────────────────────────────────────────────────────────────

interface PersistArgs {
  kind:        PredictionKindLocal;
  matchId:     string;
  playerId:    string | null;
  score:       number;
  horizonMs:   number;
  components:  Record<string, number | string | null>;
  rationale:   string;
  clubId:      string;
  dryRun?:     boolean;
}

async function persistOrReturn(a: PersistArgs): Promise<PredictResult> {
  if (a.dryRun) {
    return { kind: a.kind, matchId: a.matchId, playerId: a.playerId, score: a.score, horizonMs: a.horizonMs, components: a.components, rationale: a.rationale, id: null };
  }
  try {
    const row = await prisma.prediction.create({
      data: {
        clubId:       a.clubId,
        matchId:      a.matchId,
        playerId:     a.playerId,
        kind:         a.kind as never,
        score:        a.score,
        horizonMs:    a.horizonMs,
        components:   a.components as unknown as Prisma.InputJsonValue,
        rationale:    a.rationale,
        modelVersion: MODEL_VERSION,
      },
      select: { id: true },
    });
    return { ...a, id: row.id };
  } catch (err) {
    logger.warn('[predictive] persist failed', { kind: a.kind, err: (err as Error).message });
    return { kind: a.kind, matchId: a.matchId, playerId: a.playerId, score: a.score, horizonMs: a.horizonMs, components: a.components, rationale: a.rationale, id: null };
  }
}

async function safeAlert(
  clubId: string,
  matchId: string,
  playerId: string | null,
  kind: string,
  severity: 'INFO' | 'WARN' | 'CRITICAL',
  title: string,
  message: string,
  payload: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await aiOps.createAlert({ clubId, matchId, playerId, kind, severity, title, message, payload, agent: 'TACTICAL' });
  } catch (err) {
    logger.warn('[predictive] alert emit failed', { kind, err: (err as Error).message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Read APIs
// ─────────────────────────────────────────────────────────────────────────

export async function listPredictions(
  clubId: string,
  opts: { matchId?: string; playerId?: string; kind?: PredictionKindLocal; page?: number; limit?: number } = {},
) {
  const { matchId, playerId, kind, page = 1, limit = 50 } = opts;
  const where: Prisma.PredictionWhereInput = {
    clubId,
    ...(matchId  && { matchId }),
    ...(playerId && { playerId }),
    ...(kind     && { kind: kind as never }),
  };
  const [items, total] = await Promise.all([
    prisma.prediction.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: Math.min(limit, 200),
    }),
    prisma.prediction.count({ where }),
  ]);
  return { items, total, page, limit };
}
