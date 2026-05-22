// Familista — Autonomous Visual Tactical Engine (Phase K)
// ─────────────────────────────────────────────────────────────────────────
// DETERMINISTIC PLACEHOLDERS. No external AI. No GPU. Pure functions over
// already-persisted data (Phase G SpatialFrame + Phase F brain).
//
// Each detector writes a row to the appropriate Phase K table so the
// frontend can read them at SSE speed. detectorVersion is "v1" until we
// formally publish a new version that the audit chain pins.

import { Prisma, TacticalSignalKind, VisualTacticalSignal, TacticalPatternDetection, VisualFormationState, PressingIntensityEstimate, DefensiveLineEstimate, OverloadZoneEstimate } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { getSportAdapter } from '../sports';
import { appendAuditEventAsync } from '../security/audit-chain.service';

const DETECTOR_VERSION = 'v1';

export interface TacticalActor {
  userId: string;
  clubId: string;
  role?:  string;
}

interface DetectorInput {
  matchId:    string;
  clubId:     string;
  monotonicMs: number;
  side:       'HOME' | 'AWAY' | 'NEUTRAL';
  players:    Array<{ playerId: string; side: 'HOME' | 'AWAY'; x: number; y: number; sprint?: 0 | 1; alert?: string }>;
  geometry:   { widthM: number; heightM: number; playersPerSide: number };
}

async function loadInput(matchId: string, clubId: string, monotonicMs?: number): Promise<DetectorInput | null> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: { clubId: true, isHome: true } });
  if (!match)                  throw new NotFoundError('Match');
  if (match.clubId !== clubId) throw new ForbiddenError();

  const adapter = getSportAdapter('FOOTBALL');
  const geometry = adapter.geometry();

  const frame = monotonicMs
    ? await prisma.spatialFrame.findFirst({
        where:   { matchId, monotonicMs: { lte: BigInt(monotonicMs) } },
        orderBy: { monotonicMs: 'desc' },
      })
    : await prisma.spatialFrame.findFirst({ where: { matchId }, orderBy: { monotonicMs: 'desc' } });

  if (!frame) return null;
  const raw = (frame.players as unknown as Array<{ playerId: string; side: 'HOME'|'AWAY'; x: number | null; y: number | null; sprint?: 0|1; alert?: string }>) ?? [];
  const positioned = raw
    .filter((p) => p.x !== null && p.y !== null)
    .map((p) => ({ playerId: p.playerId, side: p.side, x: p.x as number, y: p.y as number, sprint: p.sprint ?? 0, alert: p.alert ?? 'OK' }));
  if (positioned.length === 0) return null;

  return {
    matchId,
    clubId,
    monotonicMs: Number(frame.monotonicMs),
    side: 'HOME',
    players: positioned,
    geometry: { widthM: geometry.widthM, heightM: geometry.heightM, playersPerSide: geometry.playersPerSide },
  };
}

function persistSignal(args: { clubId: string; matchId: string; signalKind: TacticalSignalKind; monotonicMs: number; side: string; intensity: number; payload: Prisma.InputJsonValue }): Promise<VisualTacticalSignal> {
  return prisma.visualTacticalSignal.create({
    data: { ...args, monotonicMs: BigInt(args.monotonicMs), payload: args.payload, detectorVersion: DETECTOR_VERSION },
  });
}

// ── 8 detectors ─────────────────────────────────────────────────────────

export async function detectFormation(actor: TacticalActor, matchId: string, monotonicMs?: number): Promise<VisualFormationState | null> {
  const inp = await loadInput(matchId, actor.clubId, monotonicMs); if (!inp) return null;
  const adapter = getSportAdapter('FOOTBALL');
  const templates = adapter.formations();
  const ours = inp.players.filter((p) => p.side === 'HOME');
  if (templates.length === 0 || ours.length === 0) return null;

  // Greedy match against each template.
  let bestName = templates[0].name, bestMean = Infinity, bestSpots = templates[0].spots;
  for (const t of templates) {
    const mean = greedyMeanDistance(ours, t.spots);
    if (mean < bestMean) { bestMean = mean; bestName = t.name; bestSpots = t.spots; }
  }
  const conf = Math.max(0, Math.min(1, 1 - bestMean / 25));

  const row = await prisma.visualFormationState.create({
    data: {
      clubId: actor.clubId, matchId, monotonicMs: BigInt(inp.monotonicMs),
      side: 'HOME', formation: bestName, spotsPayload: bestSpots as unknown as Prisma.InputJsonValue,
      confidence: conf, detectorVersion: DETECTOR_VERSION,
    },
  });
  await persistSignal({ clubId: actor.clubId, matchId, signalKind: 'FORMATION', monotonicMs: inp.monotonicMs, side: 'HOME', intensity: conf, payload: { formation: bestName, meanDistanceM: Number(bestMean.toFixed(2)) } as Prisma.InputJsonValue });
  anchor(actor, 'NEURO_FORMATION_DETECTED', 'VisualFormationState', row.id, { formation: bestName });
  return row;
}

export async function detectPressing(actor: TacticalActor, matchId: string, monotonicMs?: number): Promise<PressingIntensityEstimate | null> {
  const inp = await loadInput(matchId, actor.clubId, monotonicMs); if (!inp) return null;
  const ours = inp.players.filter((p) => p.side === 'HOME');
  const opp  = inp.players.filter((p) => p.side === 'AWAY');
  if (ours.length === 0 || opp.length === 0) return null;

  // Pressure mass: ratio of HOME players within 8m of an AWAY player.
  let pressed = 0;
  let sprintMass = 0;
  for (const o of ours) {
    const closest = opp.reduce((min, e) => Math.min(min, Math.hypot(o.x - e.x, o.y - e.y)), Infinity);
    if (closest < 8) pressed++;
    if (o.sprint) sprintMass++;
  }
  const pressureMass   = pressed / Math.max(1, ours.length);
  const synchrony      = sprintMass / Math.max(1, ours.length);
  const intensity      = Math.max(0, Math.min(1, 0.6 * pressureMass + 0.4 * synchrony));

  const row = await prisma.pressingIntensityEstimate.create({
    data: {
      clubId: actor.clubId, matchId, monotonicMs: BigInt(inp.monotonicMs),
      side: 'HOME', intensity, synchronyIndex: synchrony, pressureMass, detectorVersion: DETECTOR_VERSION,
    },
  });
  await persistSignal({ clubId: actor.clubId, matchId, signalKind: 'PRESSING', monotonicMs: inp.monotonicMs, side: 'HOME', intensity, payload: { pressureMass, synchrony } as Prisma.InputJsonValue });
  anchor(actor, 'NEURO_PRESSING_DETECTED', 'PressingIntensityEstimate', row.id, { intensity });
  return row;
}

export async function detectDefensiveLine(actor: TacticalActor, matchId: string, monotonicMs?: number): Promise<DefensiveLineEstimate | null> {
  const inp = await loadInput(matchId, actor.clubId, monotonicMs); if (!inp) return null;
  const ours = inp.players.filter((p) => p.side === 'HOME').map((p) => p.x);
  if (ours.length < 3) return null;
  ours.sort((a, b) => a - b);
  const backThird   = ours.slice(0, Math.max(2, Math.floor(ours.length / 3)));
  const lineX       = backThird.reduce((s, v) => s + v, 0) / backThird.length;
  const ysOfBack    = inp.players.filter((p) => p.side === 'HOME' && p.x <= lineX + 2).map((p) => p.y);
  const meanY       = ysOfBack.reduce((s, v) => s + v, 0) / Math.max(1, ysOfBack.length);
  const spreadY     = Math.sqrt(ysOfBack.reduce((s, v) => s + (v - meanY) ** 2, 0) / Math.max(1, ysOfBack.length));
  const stability   = Math.max(0, Math.min(1, 1 - spreadY / 30));

  const row = await prisma.defensiveLineEstimate.create({
    data: { clubId: actor.clubId, matchId, monotonicMs: BigInt(inp.monotonicMs), side: 'HOME', lineX, spreadY, stabilityIndex: stability, detectorVersion: DETECTOR_VERSION },
  });
  await persistSignal({ clubId: actor.clubId, matchId, signalKind: 'DEFENSIVE_LINE', monotonicMs: inp.monotonicMs, side: 'HOME', intensity: stability, payload: { lineX, spreadY } as Prisma.InputJsonValue });
  anchor(actor, 'NEURO_DEFLINE_DETECTED', 'DefensiveLineEstimate', row.id, { lineX, stability });
  return row;
}

export async function detectOverloadZones(actor: TacticalActor, matchId: string, monotonicMs?: number): Promise<OverloadZoneEstimate[]> {
  const inp = await loadInput(matchId, actor.clubId, monotonicMs); if (!inp) return [];
  const GX = 6, GY = 4;
  const cellW = inp.geometry.widthM / GX, cellH = inp.geometry.heightM / GY;
  const counts: Array<{ home: number; away: number; xi: number; yi: number }> = [];
  for (let i = 0; i < GX * GY; i++) counts.push({ home: 0, away: 0, xi: i % GX, yi: Math.floor(i / GX) });
  for (const p of inp.players) {
    const cx = Math.min(GX - 1, Math.max(0, Math.floor(p.x / cellW)));
    const cy = Math.min(GY - 1, Math.max(0, Math.floor(p.y / cellH)));
    const c = counts[cy * GX + cx];
    if (p.side === 'HOME') c.home++; else c.away++;
  }
  const overloaded = counts.filter((c) => Math.abs(c.home - c.away) >= 2).slice(0, 6);
  const rows: OverloadZoneEstimate[] = [];
  for (const c of overloaded) {
    const delta = c.home - c.away;
    const intensity = Math.min(1, Math.abs(delta) / 4);
    const row = await prisma.overloadZoneEstimate.create({
      data: {
        clubId: actor.clubId, matchId, monotonicMs: BigInt(inp.monotonicMs),
        zoneX: (c.xi + 0.5) * cellW, zoneY: (c.yi + 0.5) * cellH,
        homeCount: c.home, awayCount: c.away, delta, intensity, detectorVersion: DETECTOR_VERSION,
      },
    });
    rows.push(row);
    await persistSignal({ clubId: actor.clubId, matchId, signalKind: 'OVERLOAD_ZONE', monotonicMs: inp.monotonicMs, side: delta > 0 ? 'HOME' : 'AWAY', intensity, payload: { x: c.xi, y: c.yi, delta } as Prisma.InputJsonValue });
  }
  return rows;
}

export async function detectSpaceCreation(actor: TacticalActor, matchId: string, monotonicMs?: number): Promise<VisualTacticalSignal | null> {
  const inp = await loadInput(matchId, actor.clubId, monotonicMs); if (!inp) return null;
  const opp = inp.players.filter((p) => p.side === 'AWAY');
  if (opp.length < 3) return null;
  // Largest opp-to-opp gap = candidate space.
  let maxGap = 0;
  for (let i = 0; i < opp.length; i++) {
    for (let j = i + 1; j < opp.length; j++) {
      const d = Math.hypot(opp[i].x - opp[j].x, opp[i].y - opp[j].y);
      if (d > maxGap) maxGap = d;
    }
  }
  const intensity = Math.max(0, Math.min(1, (maxGap - 10) / 30));
  return persistSignal({ clubId: actor.clubId, matchId, signalKind: 'SPACE_CREATION', monotonicMs: inp.monotonicMs, side: 'HOME', intensity, payload: { maxGap: Number(maxGap.toFixed(1)) } as Prisma.InputJsonValue });
}

export async function detectTransitionMoment(actor: TacticalActor, matchId: string, monotonicMs?: number): Promise<VisualTacticalSignal | null> {
  const inp = await loadInput(matchId, actor.clubId, monotonicMs); if (!inp) return null;
  // Sprint density on HOME side.
  const sprints = inp.players.filter((p) => p.side === 'HOME' && p.sprint === 1).length;
  const ratio   = sprints / Math.max(1, inp.players.filter((p) => p.side === 'HOME').length);
  if (ratio < 0.25) return null;
  return persistSignal({ clubId: actor.clubId, matchId, signalKind: 'TRANSITION_MOMENT', monotonicMs: inp.monotonicMs, side: 'HOME', intensity: Math.min(1, ratio * 2), payload: { sprintCount: sprints, ratio: Number(ratio.toFixed(2)) } as Prisma.InputJsonValue });
}

export async function detectCounterattack(actor: TacticalActor, matchId: string, monotonicMs?: number): Promise<VisualTacticalSignal | null> {
  const inp = await loadInput(matchId, actor.clubId, monotonicMs); if (!inp) return null;
  // Heuristic: many HOME sprints in opposition half.
  const opponentHalf = inp.geometry.widthM / 2;
  const fastInOppHalf = inp.players.filter((p) => p.side === 'HOME' && p.sprint === 1 && p.x > opponentHalf).length;
  if (fastInOppHalf < 2) return null;
  const intensity = Math.min(1, fastInOppHalf / 4);
  return persistSignal({ clubId: actor.clubId, matchId, signalKind: 'COUNTERATTACK', monotonicMs: inp.monotonicMs, side: 'HOME', intensity, payload: { fastInOppHalf } as Prisma.InputJsonValue });
}

export async function detectPositionalCollapse(actor: TacticalActor, matchId: string, monotonicMs?: number): Promise<VisualTacticalSignal | null> {
  const inp = await loadInput(matchId, actor.clubId, monotonicMs); if (!inp) return null;
  const ours = inp.players.filter((p) => p.side === 'HOME');
  if (ours.length === 0) return null;
  // Y-spread on HOME side; > 50% of pitch width means stretched.
  const ys = ours.map((p) => p.y);
  const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
  const spreadY = Math.sqrt(ys.reduce((s, v) => s + (v - meanY) ** 2, 0) / ys.length);
  const ratio = spreadY / (inp.geometry.heightM / 2);
  if (ratio < 0.85) return null;
  return persistSignal({ clubId: actor.clubId, matchId, signalKind: 'POSITIONAL_COLLAPSE', monotonicMs: inp.monotonicMs, side: 'HOME', intensity: Math.min(1, ratio), payload: { spreadY: Number(spreadY.toFixed(1)) } as Prisma.InputJsonValue });
}

// ── Composite pattern detection ─────────────────────────────────────────

export async function detectPattern(actor: TacticalActor, matchId: string, monotonicMs?: number): Promise<TacticalPatternDetection | null> {
  const inp = await loadInput(matchId, actor.clubId, monotonicMs); if (!inp) return null;
  // Pull recent signals (last 30s).
  const since = BigInt(inp.monotonicMs - 30_000);
  const signals = await prisma.visualTacticalSignal.findMany({
    where:   { matchId, monotonicMs: { gte: since, lte: BigInt(inp.monotonicMs) } },
    orderBy: { monotonicMs: 'desc' },
    take:    50,
  });
  if (signals.length === 0) return null;

  const tags: string[] = [];
  if (signals.some((s) => s.signalKind === 'PRESSING'    && s.intensity > 0.6)) tags.push('HIGH_PRESS');
  if (signals.some((s) => s.signalKind === 'OVERLOAD_ZONE'  && s.intensity > 0.5)) tags.push('OVERLOAD');
  if (signals.some((s) => s.signalKind === 'TRANSITION_MOMENT')) tags.push('TRANSITION');
  if (signals.some((s) => s.signalKind === 'POSITIONAL_COLLAPSE')) tags.push('COLLAPSE');
  if (tags.length === 0) return null;

  const intensity = Math.min(1, signals.reduce((s, x) => s + x.intensity, 0) / signals.length);
  const row = await prisma.tacticalPatternDetection.create({
    data: {
      clubId: actor.clubId, matchId, monotonicMs: BigInt(inp.monotonicMs),
      patternKind: tags.join('+'),
      contributingSignalIds: signals.map((s) => s.id) as unknown as Prisma.InputJsonValue,
      intensity,
      rationale: `Pattern composed from ${signals.length} signals over the last 30s.`,
      detectorVersion: DETECTOR_VERSION,
    },
  });
  anchor(actor, 'NEURO_PATTERN_DETECTED', 'TacticalPatternDetection', row.id, { pattern: tags.join('+'), intensity });
  return row;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function greedyMeanDistance(positions: Array<{ x: number; y: number }>, spots: Array<{ x: number; y: number }>): number {
  if (positions.length === 0 || spots.length === 0) return Infinity;
  const used = new Set<number>();
  let total = 0, count = 0;
  for (const p of positions) {
    let bestIdx = -1, bestD = Infinity;
    for (let i = 0; i < spots.length; i++) {
      if (used.has(i)) continue;
      const d = Math.hypot(p.x - spots[i].x, p.y - spots[i].y);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    if (bestIdx === -1) break;
    used.add(bestIdx);
    total += bestD; count++;
  }
  return count === 0 ? Infinity : total / count;
}

function anchor(actor: TacticalActor, action: string, entityType: string, entityId: string, payload: Record<string, unknown>): void {
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action,
    entityType,
    entityId,
    payload,
  });
}
