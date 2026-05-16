// Familista — Vision Intelligence Engine
// File location: src/lib/vision-analytics.lib.ts
//
// Pure deterministic analytics. Every function consumes PlayerTrack /
// BallTrack / MatchEvent slices and returns a strongly-typed analytics
// payload. No I/O, no LLM, no random — board-safe and replayable.

import type {
  PlayerTrack,
  BallTrack,
  MatchEvent,
  TeamSide,
} from '@prisma/client';
import type {
  HeatmapPayload,
  PassingNetworkPayload,
  PassingNetworkNode,
  PassingNetworkEdge,
  FormationSnapshotPayload,
  PressingEventPayload,
  PossessionBlockPayload,
  ShapeCompactnessPayload,
  SprintProfilePayload,
  TechnicalExecutionPayload,
  PitchPoint,
} from '../types/vision.types';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
function distance(a: PitchPoint, b: PitchPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ─────────────────────────────────────────────────────────────────────────────
// Heatmap — bin player positions into a zonesX × zonesY grid
// ─────────────────────────────────────────────────────────────────────────────

export function buildHeatmap(
  tracks: Pick<PlayerTrack, 'avgX' | 'avgY' | 'startMs' | 'endMs'>[],
  opts: { zonesX?: number; zonesY?: number } = {},
): HeatmapPayload {
  const zonesX = opts.zonesX ?? 24;
  const zonesY = opts.zonesY ?? 16;
  const cells: number[][] = Array.from({ length: zonesY }, () => Array(zonesX).fill(0));
  let totalSeconds = 0;

  for (const t of tracks) {
    const durSec = Math.max(0, (t.endMs - t.startMs) / 1000);
    if (durSec <= 0) continue;
    const xi = clamp(Math.floor((t.avgX / 100) * zonesX), 0, zonesX - 1);
    const yi = clamp(Math.floor((t.avgY / 100) * zonesY), 0, zonesY - 1);
    cells[yi][xi] += durSec;
    totalSeconds += durSec;
  }

  return {
    zonesX,
    zonesY,
    cells: cells.map((row) => row.map((c) => round2(c))),
    totalSeconds: round2(totalSeconds),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Passing network — graph of pass events between players on one team
// ─────────────────────────────────────────────────────────────────────────────

export function buildPassingNetwork(
  events: Pick<MatchEvent, 'type' | 'primaryPlayerId' | 'secondaryPlayerId' | 'teamSide' | 'pitchX' | 'pitchY' | 'payload'>[],
  side: TeamSide,
): PassingNetworkPayload {
  const passes = events.filter(
    (e) => e.type === 'PASS' && e.teamSide === side && e.primaryPlayerId && e.secondaryPlayerId,
  );

  type NodeAgg = { totalPasses: number; sumX: number; sumY: number; samples: number };
  const nodeMap = new Map<string, NodeAgg>();
  type EdgeAgg = { count: number; lengthSum: number; successful: number };
  const edgeMap = new Map<string, EdgeAgg>();

  for (const p of passes) {
    const from = p.primaryPlayerId!;
    const to = p.secondaryPlayerId!;
    const fa = nodeMap.get(from) ?? { totalPasses: 0, sumX: 0, sumY: 0, samples: 0 };
    fa.totalPasses++;
    if (p.pitchX != null && p.pitchY != null) {
      fa.sumX += p.pitchX;
      fa.sumY += p.pitchY;
      fa.samples++;
    }
    nodeMap.set(from, fa);

    if (!nodeMap.has(to)) nodeMap.set(to, { totalPasses: 0, sumX: 0, sumY: 0, samples: 0 });

    const key = `${from}->${to}`;
    const e = edgeMap.get(key) ?? { count: 0, lengthSum: 0, successful: 0 };
    e.count++;
    const length = ((p.payload as { length?: number } | null)?.length) ?? 0;
    e.lengthSum += length;
    const success = ((p.payload as { successful?: boolean } | null)?.successful) ?? true;
    if (success) e.successful++;
    edgeMap.set(key, e);
  }

  const nodes: PassingNetworkNode[] = Array.from(nodeMap.entries()).map(([id, a]) => ({
    playerId: id,
    jerseyNumber: null,
    avgPos: { x: a.samples > 0 ? round2(a.sumX / a.samples) : 50, y: a.samples > 0 ? round2(a.sumY / a.samples) : 50 },
    totalPasses: a.totalPasses,
    position: null,
  }));

  const edges: PassingNetworkEdge[] = Array.from(edgeMap.entries()).map(([key, e]) => {
    const [from, to] = key.split('->');
    return {
      from,
      to,
      count: e.count,
      avgLength: e.count > 0 ? round2(e.lengthSum / e.count) : 0,
      successRate: e.count > 0 ? round2(e.successful / e.count) : 1,
    };
  });

  const successful = edges.reduce((s, e) => s + e.successRate * e.count, 0);
  const totalPasses = passes.length;
  return {
    teamSide: side,
    nodes,
    edges,
    totalPasses,
    passAccuracy: totalPasses > 0 ? round2(successful / totalPasses) : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formation recognition — cluster outfield positions into row counts
// ─────────────────────────────────────────────────────────────────────────────

const FORMATION_PATTERNS: Array<{ name: string; rows: number[] }> = [
  { name: '4-3-3', rows: [4, 3, 3] },
  { name: '4-4-2', rows: [4, 4, 2] },
  { name: '4-2-3-1', rows: [4, 2, 3, 1] },
  { name: '3-5-2', rows: [3, 5, 2] },
  { name: '5-3-2', rows: [5, 3, 2] },
  { name: '3-4-3', rows: [3, 4, 3] },
  { name: '4-1-4-1', rows: [4, 1, 4, 1] },
  { name: '4-5-1', rows: [4, 5, 1] },
];

function matchFormation(rows: number[]): string {
  // Find best matching canonical formation by L1 distance over outfield rows
  let best = '';
  let bestScore = Infinity;
  for (const pat of FORMATION_PATTERNS) {
    if (pat.rows.length !== rows.length) continue;
    const dist = pat.rows.reduce((s, r, i) => s + Math.abs(r - rows[i]), 0);
    if (dist < bestScore) {
      bestScore = dist;
      best = pat.name;
    }
  }
  return best || rows.join('-');
}

export function detectFormation(
  tracks: Pick<PlayerTrack, 'playerId' | 'jerseyNumber' | 'teamSide' | 'avgX' | 'avgY' | 'startMs' | 'endMs'>[],
  side: TeamSide,
  opts: { windowStartMs?: number; windowEndMs?: number; lineCount?: 3 | 4 } = {},
): FormationSnapshotPayload {
  const inWindow = tracks.filter((t) => {
    if (t.teamSide !== side) return false;
    if (opts.windowStartMs != null && t.endMs < opts.windowStartMs) return false;
    if (opts.windowEndMs != null && t.startMs > opts.windowEndMs) return false;
    return true;
  });

  // Aggregate avg position per player
  type PlayerAgg = { playerId: string | null; jerseyNumber: number | null; sumX: number; sumY: number; samples: number };
  const byPlayer = new Map<string, PlayerAgg>();
  for (const t of inWindow) {
    const key = t.playerId ?? `#${t.jerseyNumber ?? Math.random()}`;
    const a = byPlayer.get(key) ?? { playerId: t.playerId, jerseyNumber: t.jerseyNumber, sumX: 0, sumY: 0, samples: 0 };
    a.sumX += t.avgX;
    a.sumY += t.avgY;
    a.samples++;
    byPlayer.set(key, a);
  }

  const positions = Array.from(byPlayer.values())
    .map((a) => ({
      playerId: a.playerId,
      jerseyNumber: a.jerseyNumber,
      pos: { x: round2(a.sumX / a.samples), y: round2(a.sumY / a.samples) } as PitchPoint,
    }))
    .sort((a, b) => a.pos.x - b.pos.x); // sort by attacking direction

  // Exclude likely goalkeeper (player with extreme X near own goal)
  const outfield = positions.length >= 11 ? positions.slice(1) : positions;

  // Split into lines by X buckets — 3 or 4 lines based on player count
  const lineCount = opts.lineCount ?? (outfield.length >= 9 ? 4 : 3);
  const xs = outfield.map((p) => p.pos.x);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 100);
  const bandWidth = (maxX - minX) / lineCount;
  const buckets: number[] = Array(lineCount).fill(0);
  for (const p of outfield) {
    const bi = clamp(Math.floor((p.pos.x - minX) / Math.max(bandWidth, 0.0001)), 0, lineCount - 1);
    buckets[bi]++;
  }

  return {
    teamSide: side,
    formation: matchFormation(buckets),
    windowStartMs: opts.windowStartMs ?? 0,
    windowEndMs: opts.windowEndMs ?? Math.max(...tracks.map((t) => t.endMs), 0),
    rows: buckets,
    averagePositions: positions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pressing detection — multiple defenders converge on ball-carrier
// ─────────────────────────────────────────────────────────────────────────────

export function detectPressing(
  tracks: Pick<PlayerTrack, 'playerId' | 'teamSide' | 'avgX' | 'avgY' | 'startMs' | 'endMs'>[],
  events: Pick<MatchEvent, 'type' | 'primaryPlayerId' | 'teamSide' | 'occurredAtMs' | 'pitchX' | 'pitchY'>[],
  opts: { pressureRadius?: number; minDefenders?: number; windowMs?: number } = {},
): PressingEventPayload[] {
  const pressureRadius = opts.pressureRadius ?? 8; // pitch units
  const minDefenders = opts.minDefenders ?? 2;
  const windowMs = opts.windowMs ?? 3000;

  const possessionAnchors = events.filter(
    (e) =>
      (e.type === 'PASS' || e.type === 'DRIBBLE') &&
      e.primaryPlayerId != null &&
      e.pitchX != null &&
      e.pitchY != null,
  );

  const results: PressingEventPayload[] = [];
  for (const anchor of possessionAnchors) {
    const carrier = anchor.primaryPlayerId!;
    const carrierTeam = anchor.teamSide;
    const ax = anchor.pitchX!;
    const ay = anchor.pitchY!;

    // Defenders = tracks for other side overlapping the anchor window
    const relevantTracks = tracks.filter(
      (t) =>
        t.teamSide !== carrierTeam &&
        t.teamSide !== 'UNKNOWN' &&
        t.endMs >= anchor.occurredAtMs - 500 &&
        t.startMs <= anchor.occurredAtMs + windowMs,
    );

    const closeDefenders = relevantTracks.filter(
      (t) => distance({ x: t.avgX, y: t.avgY }, { x: ax, y: ay }) <= pressureRadius,
    );

    if (closeDefenders.length >= minDefenders) {
      results.push({
        triggeredAtMs: anchor.occurredAtMs,
        durationMs: windowMs,
        defendersInvolved: closeDefenders
          .map((d) => d.playerId)
          .filter((id): id is string => id != null)
          .slice(0, 6),
        attackerInvolved: carrier,
        pitchOrigin: { x: round2(ax), y: round2(ay) },
        pressureRadius,
        outcome: 'NO_EFFECT',
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Possession — sum durations between POSSESSION_CHANGE events
// ─────────────────────────────────────────────────────────────────────────────

export function computePossession(
  events: Pick<MatchEvent, 'type' | 'occurredAtMs' | 'teamSide'>[],
  windowStartMs: number,
  windowEndMs: number,
): PossessionBlockPayload {
  const inWindow = events
    .filter((e) => e.occurredAtMs >= windowStartMs && e.occurredAtMs <= windowEndMs)
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs);

  let homeMs = 0;
  let awayMs = 0;
  let contestedMs = 0;
  let currentSide: TeamSide = 'UNKNOWN';
  let lastChangeMs = windowStartMs;

  for (const e of inWindow) {
    if (e.type !== 'POSSESSION_CHANGE') continue;
    const dur = e.occurredAtMs - lastChangeMs;
    if (currentSide === 'HOME') homeMs += dur;
    else if (currentSide === 'AWAY') awayMs += dur;
    else contestedMs += dur;
    currentSide = e.teamSide;
    lastChangeMs = e.occurredAtMs;
  }

  const tailDur = windowEndMs - lastChangeMs;
  if (currentSide === 'HOME') homeMs += tailDur;
  else if (currentSide === 'AWAY') awayMs += tailDur;
  else contestedMs += tailDur;

  return {
    windowStartMs,
    windowEndMs,
    homeSeconds: round2(homeMs / 1000),
    awaySeconds: round2(awayMs / 1000),
    contestedSeconds: round2(contestedMs / 1000),
    homePassCount: events.filter((e) => e.type === 'PASS' && e.teamSide === 'HOME').length,
    awayPassCount: events.filter((e) => e.type === 'PASS' && e.teamSide === 'AWAY').length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape compactness — avg pairwise distance within a side
// ─────────────────────────────────────────────────────────────────────────────

export function computeShapeCompactness(
  tracks: Pick<PlayerTrack, 'teamSide' | 'avgX' | 'avgY' | 'playerId'>[],
  side: TeamSide,
): ShapeCompactnessPayload {
  const positions = tracks
    .filter((t) => t.teamSide === side)
    .map((t) => ({ x: t.avgX, y: t.avgY }));

  if (positions.length < 2) {
    return {
      teamSide: side,
      avgPairwiseDistance: 0,
      defensiveLineHeight: 0,
      attackingLineHeight: 0,
      width: 0,
      length: 0,
    };
  }

  let total = 0;
  let pairs = 0;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      total += distance(positions[i], positions[j]);
      pairs++;
    }
  }

  const xs = positions.map((p) => p.x);
  const ys = positions.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    teamSide: side,
    avgPairwiseDistance: round2(total / pairs),
    defensiveLineHeight: round2(minX),
    attackingLineHeight: round2(maxX),
    width: round2(maxY - minY),
    length: round2(maxX - minX),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sprint profile — per-player aggregated sprint metrics
// ─────────────────────────────────────────────────────────────────────────────

export function computeSprintProfile(
  tracks: Pick<PlayerTrack, 'playerId' | 'topSpeedKmh' | 'sprintCount' | 'accelerations' | 'decelerations' | 'totalDistanceM'>[],
  playerId: string,
): SprintProfilePayload {
  const owned = tracks.filter((t) => t.playerId === playerId);
  if (owned.length === 0) {
    return {
      playerId,
      sprintCount: 0,
      totalSprintDistance: 0,
      maxSprintSpeedKmh: 0,
      avgAccelerationMs2: 0,
      avgDecelerationMs2: 0,
      recoveryTimeSec: null,
    };
  }
  const sprintCount = owned.reduce((s, t) => s + (t.sprintCount ?? 0), 0);
  const totalDist = owned.reduce((s, t) => s + (t.totalDistanceM ?? 0), 0);
  const maxSpeed = Math.max(0, ...owned.map((t) => t.topSpeedKmh ?? 0));
  const accel = owned.reduce((s, t) => s + (t.accelerations ?? 0), 0);
  const decel = owned.reduce((s, t) => s + (t.decelerations ?? 0), 0);
  return {
    playerId,
    sprintCount,
    totalSprintDistance: round2(totalDist),
    maxSprintSpeedKmh: round2(maxSpeed),
    avgAccelerationMs2: round2(accel / Math.max(owned.length, 1)),
    avgDecelerationMs2: round2(decel / Math.max(owned.length, 1)),
    recoveryTimeSec: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Technical execution — success rate of action-type events
// ─────────────────────────────────────────────────────────────────────────────

export function computeTechnicalExecution(
  events: Pick<MatchEvent, 'type' | 'primaryPlayerId' | 'confidence' | 'payload'>[],
  playerId: string,
  metric: TechnicalExecutionPayload['metric'],
): TechnicalExecutionPayload {
  const typeFor: Record<TechnicalExecutionPayload['metric'], MatchEvent['type']> = {
    PASSING: 'PASS',
    SHOOTING: 'SHOT',
    DRIBBLING: 'DRIBBLE',
    TACKLING: 'TACKLE',
    AERIAL: 'HEADER',
  };
  const targetType = typeFor[metric];
  const owned = events.filter((e) => e.type === targetType && e.primaryPlayerId === playerId);
  const successful = owned.filter((e) => {
    const p = e.payload as { successful?: boolean } | null;
    return p?.successful !== false;
  }).length;
  const avgConfidence =
    owned.length > 0 ? round2(owned.reduce((s, e) => s + e.confidence, 0) / owned.length) : 0;

  return {
    playerId,
    metric,
    attempts: owned.length,
    successful,
    successRate: owned.length > 0 ? round2(successful / owned.length) : 0,
    avgConfidence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transition speed — average time from possession win → final-third entry
// ─────────────────────────────────────────────────────────────────────────────

export function computeTransitionSpeed(
  events: Pick<MatchEvent, 'type' | 'teamSide' | 'occurredAtMs' | 'pitchX'>[],
  side: TeamSide,
): { avgTransitionMs: number | null; samples: number } {
  const sorted = events.filter((e) => e.teamSide === side).sort((a, b) => a.occurredAtMs - b.occurredAtMs);
  let samples = 0;
  let totalMs = 0;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (e.type !== 'POSSESSION_CHANGE') continue;
    // Find first event after this with pitchX > 66 (final third for HOME) or < 33 (final third for AWAY)
    for (let j = i + 1; j < sorted.length; j++) {
      const ne = sorted[j];
      if (ne.teamSide !== side) continue;
      if (ne.pitchX == null) continue;
      const inFinalThird = side === 'HOME' ? ne.pitchX > 66 : ne.pitchX < 33;
      if (inFinalThird) {
        totalMs += ne.occurredAtMs - e.occurredAtMs;
        samples++;
        break;
      }
    }
  }
  return { avgTransitionMs: samples > 0 ? Math.round(totalMs / samples) : null, samples };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build-up pattern detection — labels for the first 3-5 passes after wins
// ─────────────────────────────────────────────────────────────────────────────

export function detectBuildUpPatterns(
  events: Pick<MatchEvent, 'type' | 'teamSide' | 'pitchX' | 'pitchY' | 'occurredAtMs'>[],
  side: TeamSide,
): string[] {
  const passes = events
    .filter((e) => e.type === 'PASS' && e.teamSide === side && e.pitchX != null)
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs);

  const patterns: string[] = [];
  for (let i = 0; i + 2 < passes.length; i++) {
    const a = passes[i];
    const b = passes[i + 1];
    const c = passes[i + 2];
    const dx = (c.pitchX ?? 50) - (a.pitchX ?? 50);
    const dy = Math.abs((c.pitchY ?? 50) - (a.pitchY ?? 50));
    if (side === 'HOME' && dx > 25 && dy < 20) patterns.push('VERTICAL_PROGRESSION');
    else if (side === 'AWAY' && dx < -25 && dy < 20) patterns.push('VERTICAL_PROGRESSION');
    else if (dy > 35) patterns.push('SWITCH_OF_PLAY');
    else patterns.push('SHORT_BUILDUP');
  }

  // Deduplicate while preserving order, keep top-3 most frequent
  const counts = new Map<string, number>();
  for (const p of patterns) counts.set(p, (counts.get(p) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ball-in-play seconds
// ─────────────────────────────────────────────────────────────────────────────

export function computeBallInPlay(tracks: BallTrack[]): number {
  const inPlay = tracks.reduce((s, b) => s + (b.inPlayMs ?? 0), 0);
  return round2(inPlay / 1000);
}
