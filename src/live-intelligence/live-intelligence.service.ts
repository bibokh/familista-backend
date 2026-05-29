// src/live-intelligence/live-intelligence.service.ts
// Phase 15 — Live Match Intelligence
//
// Single composite endpoint that aggregates all real match data into a
// structured intelligence bundle. No mock data. No invented metrics.
// Pure deterministic scoring from real DB columns.
//
// Data sources:
//   Match           — score, status, formation, possession, shots, liveMinute
//   MatchTimeline   — all non-deleted events (kinds, minute, side, pitchX/Y)
//   PlayerMatchStats— Phase Q rich stats: xg, xa, pressures, tackles, ratings
//   MatchLineup     — formations + position grid for tactical board
//   WorkloadRecord  — ACWR per player for fatigue index (weekStart-based)
//   buildMatchBrain — Phase F momentum, possession %, pressure zones (reused)

import { prisma }           from '../config/database';
import { buildMatchBrain }  from '../realtime/match-brain';
import { ForbiddenError, NotFoundError } from '../utils/errors';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TimelineSummary {
  totalEvents:    number;
  goals:          number;
  shotsOnTarget:  number;
  shots:          number;
  corners:        number;
  fouls:          number;
  yellowCards:    number;
  redCards:       number;
  byMinute:       Array<{ minute: number; kind: string; side: string }>;
}

export interface TacticalBoardData {
  formationHome:  string | null;
  formationAway:  string | null;
  positions:      Array<{
    playerId:      string | null;
    playerName:    string | null;
    jerseyNumber:  number | null;
    position:      string | null;
    x:             number;
    y:             number;
    isStarter:     boolean;
    side:          string;
    rating:        number | null;
  }>;
  possession:     number; // 0-100 our %
}

export interface CoachRecommendation {
  priority:    'HIGH' | 'MEDIUM' | 'LOW';
  area:        string;
  finding:     string;
  action:      string;
}

export interface PlayerRatingRow {
  playerId:         string;
  name:             string;
  position:         string | null;
  jerseyNumber:     number | null;
  minutesPlayed:    number;
  rating:           number;   // 1.0–10.0
  goals:            number;
  assists:          number;
  xg:               number;
  xa:               number;
  keyPasses:        number;
  tacklesWon:       number;
  pressures:        number;
  isRatingComputed: boolean; // true = fallback formula; false = stored ratingFamilista
}

export interface DominanceWindow {
  fromMin:   number;
  toMin:     number;
  homeScore: number;  // 0-100; 50 = level
  label:     string;
}

export interface FatigueRow {
  playerId:        string;
  name:            string;
  position:        string | null;
  minutesPlayed:   number;
  fatigueIndex:    number;   // 0-100
  pressureSuccess: number;   // 0-100 %
  acwr:            number | null;
  riskLevel:       'HIGH' | 'MEDIUM' | 'LOW';
}

// ── Phase 17 — Spatial Analysis types ─────────────────────────────────────────

/** Player density cell on a 10×10 grid (coords 0-100). */
export interface HeatmapCell {
  cx: number;           // cell-centre X, 0-100
  cy: number;           // cell-centre Y, 0-100
  homeDensity: number;  // 0-1 normalised
  awayDensity: number;  // 0-1 normalised
}

/** Event-density cell for pressure visualisation. */
export interface PressureCell {
  cx: number;
  cy: number;
  intensity: number;   // 0-1
  eventCount: number;
}

/** Proximity-based passing connection between two players. */
export interface PassingEdge {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  weight: number;      // 0-1, inverse distance normalised
  side: 'HOME' | 'AWAY';
}

/** Shape metrics for one team's starting XI. */
export interface TeamShapeMetrics {
  side: 'HOME' | 'AWAY';
  centroidX: number;
  centroidY: number;
  compactness: number;   // 0-100; higher = more spread
  width: number;         // forward-backward span (x-axis), 0-100
  depth: number;         // side-to-side span (y-axis), 0-100
  defensiveX: number;    // avg x of deepest 3 players (0=own goal)
  attackingX: number;    // avg x of highest 3 players (100=opp goal)
  spacingAnomalies: Array<{ name: string; x: number; y: number; gap: number }>;
}

/** Overload balance in one of 9 pitch zones (3 cols × 3 rows). */
export interface OverloadZone {
  col: 'LEFT' | 'CENTER' | 'RIGHT';
  row: 'DEFENSIVE' | 'MIDDLE' | 'ATTACKING';
  homeCount: number;
  awayCount: number;
  dominantSide: 'HOME' | 'AWAY' | 'BALANCED';
  magnitude: number;   // |homeCount - awayCount|
}

/** Full spatial bundle attached to the intelligence payload. */
export interface SpatialAnalysis {
  heatmap: HeatmapCell[];
  pressureMap: PressureCell[];
  passingNetwork: PassingEdge[];
  homeShape: TeamShapeMetrics;
  awayShape: TeamShapeMetrics;
  overloadZones: OverloadZone[];
  /** Per-5-min-window event-activity proxy for formation shift. */
  formationShiftSeries: Array<{
    label: string;
    homeWidth: number;
    awayWidth: number;
    homeCompactness: number;
    awayCompactness: number;
  }>;
}

// ── Phase 18 — Predictive Intelligence types ──────────────────────────────────

export interface PredictiveIntelligence {
  momentumForecast: {
    direction:  'HOME' | 'AWAY' | 'STABLE';
    confidence: number;   // 0-1
    slope:      number;   // normalised dominance slope (-1…+1)
    note:       string;
  };
  goalThreat: {
    probability: number;               // 0-100
    threatSide:  'HOME' | 'AWAY' | 'BALANCED';
    windowMin:   number;               // prediction window (minutes)
    drivers:     string[];
  };
  fatigueRisk: {
    peakRisk:    'HIGH' | 'MEDIUM' | 'LOW';
    riskyCount:  number;
    riskPlayers: Array<{ name: string; fatigueIndex: number; minutesPlayed: number }>;
    peakMinute:  number | null;
  };
  counterThreat: {
    level:      'HIGH' | 'MEDIUM' | 'LOW';
    likelyZone: 'LEFT' | 'CENTER' | 'RIGHT' | null;
    note:       string;
  };
  shapeCollapse: {
    risk:       'HIGH' | 'MEDIUM' | 'LOW';
    score:      number;    // 0-100 composite
    indicators: string[];
  };
  possessionSwing: {
    currentPct:  number;
    forecastPct: number;
    trend:       'GAINING' | 'LOSING' | 'STABLE';
    confidence:  number;   // 0-1
  };
}

export interface LiveIntelligenceBundle {
  matchId:              string;
  clubId:               string;
  status:               string;
  liveMinute:           number | null;
  score:                { home: number | null; away: number | null };
  homeTeam:             string;
  awayTeam:             string;
  formationHome:        string | null;
  formationAway:        string | null;
  computedAt:           string;
  timelineSummary:      TimelineSummary;
  momentum:             { index: number; windowSec: number; notes: string[] };
  possession:           { ourPct: number; windowSec: number };
  tacticalBoard:        TacticalBoardData;
  coachRecommendations: CoachRecommendation[];
  playerRatings:        PlayerRatingRow[];
  dominanceSeries:      DominanceWindow[];
  fatigueIndicators:    FatigueRow[];
  spatialAnalysis:      SpatialAnalysis;
  predictions:          PredictiveIntelligence;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DOMINANCE_BIN_MIN = 5; // 5-minute windows

// Event weight map for dominance computation (our side = positive)
const DOMINANCE_WEIGHTS: Record<string, number> = {
  GOAL:             25,
  PENALTY_SCORED:   25,
  SHOT_ON_TARGET:    6,
  SHOT:              3,
  CORNER:            2,
  POSSESSION_TICK:   1,
  FOUL:             -1,  // negative always hurts our dominance
  YELLOW_CARD:      -3,
  RED_CARD:         -8,
};

// ── Pure exported functions (unit-testable, no DB) ─────────────────────────────

/**
 * Compute Familista player rating (1.0–10.0) from raw match stats.
 * Used as fallback when ratingFamilista is null.
 */
export function computePlayerRating(stats: {
  goals:           number;
  assists:         number;
  shotsOnTarget:   number;
  xa:              number;
  foulsCommitted:  number;
  yellowCards:     number;
  redCards:        number;
  tackles:         number;
  tacklesWon:      number;
  passes:          number;
  passAccuracy:    number;
  minutesPlayed:   number;
}): number {
  let r = 6.0;
  r += stats.goals   * 1.5;
  r += stats.assists * 1.0;
  r += stats.shotsOnTarget * 0.15;
  if (stats.xa > 0) r += stats.xa * 0.8;
  r -= stats.foulsCommitted * 0.1;
  r -= stats.yellowCards * 0.5;
  r -= stats.redCards * 2.0;
  if (stats.tackles > 0) r += (stats.tacklesWon / stats.tackles) * 0.5;
  if (stats.passes > 5)  r += ((stats.passAccuracy - 70) / 100);
  if (stats.minutesPlayed < 15) r = Math.min(r, 6.5);
  return Math.max(1.0, Math.min(10.0, Math.round(r * 10) / 10));
}

/**
 * Compute fatigue index (0–100) from minutes, pressure efficiency, and ACWR.
 */
export function computeFatigueIndex(
  minutesPlayed:       number,
  pressures:           number,
  pressuresSuccessful: number,
  acwr:                number | null,
): number {
  const base          = (minutesPlayed / 90) * 85;
  const pressureRate  = pressures > 0 ? pressuresSuccessful / pressures : 1;
  const pressureDrain = pressureRate < 0.4 ? 8 : 0;
  const acwrBonus     = acwr == null ? 0 : acwr > 1.5 ? 20 : acwr > 1.3 ? 12 : 0;
  return Math.min(100, Math.round(base + pressureDrain + acwrBonus));
}

/**
 * Build per-minute dominance bins from timeline events.
 * Returns one entry per DOMINANCE_BIN_MIN-minute block up to maxMinute.
 * homeScore 50 = even; >50 = home dominant; <50 = away dominant.
 */
export function buildDominanceSeries(
  events:    Array<{ occurredAtMin: number; kind: string; side: 'HOME' | 'AWAY' }>,
  maxMinute: number,
): DominanceWindow[] {
  if (maxMinute <= 0) return [];
  const bins = Math.ceil(maxMinute / DOMINANCE_BIN_MIN);
  const nets = new Array<number>(bins).fill(0);

  for (const e of events) {
    const bin    = Math.min(bins - 1, Math.floor(e.occurredAtMin / DOMINANCE_BIN_MIN));
    const weight = DOMINANCE_WEIGHTS[e.kind] ?? 0;
    if (weight === 0) continue;
    if (weight < 0) {
      nets[bin] += weight; // negative weights always hurt our (home) dominance
    } else {
      nets[bin] += e.side === 'HOME' ? weight : -weight;
    }
  }

  return nets.map((net, i) => {
    const fromMin   = i * DOMINANCE_BIN_MIN;
    const toMin     = fromMin + DOMINANCE_BIN_MIN;
    const homeScore = Math.max(0, Math.min(100, 50 + net * 2));
    return { fromMin, toMin, homeScore, label: `${fromMin}'–${toMin}'` };
  });
}

// ── Phase 17 — Spatial computation (pure, no DB) ──────────────────────────────

const HEATMAP_GRID = 10;           // 10×10 grid; each cell = 10×10 in 0-100 coords
const HEATMAP_BLEED = 0.3;         // density contributed to adjacent cells

/**
 * Build player density heatmap from lineup positions.
 * Both HOME and AWAY densities are returned per cell (0-1 normalised).
 */
export function computeHeatmap(positions: TacticalBoardData['positions']): HeatmapCell[] {
  const N = HEATMAP_GRID;
  const CW = 100 / N;
  const homeGrid = new Float32Array(N * N);
  const awayGrid = new Float32Array(N * N);

  for (const p of positions) {
    if (!p.isStarter) continue;
    const col = Math.min(N - 1, Math.floor(p.x / CW));
    const row = Math.min(N - 1, Math.floor(p.y / CW));
    const grid = p.side === 'HOME' ? homeGrid : awayGrid;
    grid[row * N + col] += 1;
    // Bleed to 4-connected neighbours
    for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as [number, number][]) {
      const nc = col + dc, nr = row + dr;
      if (nc >= 0 && nc < N && nr >= 0 && nr < N) grid[nr * N + nc] += HEATMAP_BLEED;
    }
  }

  const maxH = Math.max(1, ...homeGrid);
  const maxA = Math.max(1, ...awayGrid);
  const cells: HeatmapCell[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const hd = homeGrid[r * N + c] / maxH;
      const ad = awayGrid[r * N + c] / maxA;
      if (hd < 0.05 && ad < 0.05) continue;
      cells.push({ cx: c * CW + CW / 2, cy: r * CW + CW / 2, homeDensity: hd, awayDensity: ad });
    }
  }
  return cells;
}

const PRESSURE_KINDS = new Set([
  'SHOT', 'SHOT_ON_TARGET', 'SHOT_OFF_TARGET', 'CORNER', 'FOUL', 'YELLOW_CARD',
]);

/**
 * Build pressure-intensity cells from timeline events that carry pitch coordinates.
 * Events without pitchX/pitchY are silently skipped.
 */
export function computePressureMap(
  events: Array<{ occurredAtMin: number; kind: string; side: string; pitchX: number | null; pitchY: number | null }>,
  maxMinute: number,
): PressureCell[] {
  const N = HEATMAP_GRID;
  const CW = 100 / N;
  const grid = new Float32Array(N * N);
  const count = new Int32Array(N * N);

  for (const e of events) {
    if (!PRESSURE_KINDS.has(e.kind)) continue;
    if (e.pitchX == null || e.pitchY == null) continue;
    const col = Math.min(N - 1, Math.floor(e.pitchX / CW));
    const row = Math.min(N - 1, Math.floor(e.pitchY / CW));
    const idx = row * N + col;
    // Recency weight: later events weigh more
    const recency = maxMinute > 0 ? 0.5 + (e.occurredAtMin / maxMinute) * 0.5 : 1;
    grid[idx] += recency;
    count[idx]++;
  }

  const max = Math.max(1, ...grid);
  const cells: PressureCell[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const idx = r * N + c;
      if (grid[idx] === 0) continue;
      cells.push({
        cx: c * CW + CW / 2, cy: r * CW + CW / 2,
        intensity: grid[idx] / max,
        eventCount: count[idx],
      });
    }
  }
  return cells;
}

/**
 * Build proximity-based passing network edges for starters of each side.
 * Each player is connected to their 2 nearest teammates. Duplicate edges pruned.
 */
export function computePassingNetwork(positions: TacticalBoardData['positions']): PassingEdge[] {
  const edges: PassingEdge[] = [];
  for (const side of ['HOME', 'AWAY'] as const) {
    const players = positions.filter(p => p.side === side && p.isStarter);
    if (players.length < 2) continue;

    const seen = new Set<string>();
    for (let i = 0; i < players.length; i++) {
      const pi = players[i];
      const sorted = players
        .map((pj, j) => ({ j, dist: Math.hypot(pi.x - pj.x, pi.y - pj.y) }))
        .filter(({ j }) => j !== i)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 2);   // 2 nearest teammates

      for (const { j, dist } of sorted) {
        const key = [Math.min(i, j), Math.max(i, j)].join('-');
        if (seen.has(key)) continue;
        seen.add(key);
        const pj = players[j];
        const weight = Math.max(0, 1 - dist / 100);  // 100 = full pitch diagonal norm
        edges.push({ fromX: pi.x, fromY: pi.y, toX: pj.x, toY: pj.y, weight, side });
      }
    }
  }
  return edges;
}

/**
 * Compute shape metrics (compactness, width, depth, lines) for one team's starters.
 */
export function computeTeamShape(
  positions: TacticalBoardData['positions'],
  side: 'HOME' | 'AWAY',
): TeamShapeMetrics {
  const players = positions.filter(p => p.side === side && p.isStarter);
  if (players.length === 0) {
    return {
      side, centroidX: 50, centroidY: 50, compactness: 0, width: 0, depth: 0,
      defensiveX: 50, attackingX: 50, spacingAnomalies: [],
    };
  }

  const xs   = players.map(p => p.x);
  const ys   = players.map(p => p.y);
  const cX   = xs.reduce((a, b) => a + b, 0) / players.length;
  const cY   = ys.reduce((a, b) => a + b, 0) / players.length;
  const width  = Math.max(...xs) - Math.min(...xs);
  const depth  = Math.max(...ys) - Math.min(...ys);

  const dists  = players.map(p => Math.hypot(p.x - cX, p.y - cY));
  const mean   = dists.reduce((a, b) => a + b, 0) / dists.length;
  const variance = dists.reduce((s, d) => s + (d - mean) ** 2, 0) / dists.length;
  const stdDev = Math.sqrt(variance);
  const compactness = Math.min(100, Math.round((mean / 50) * 100));

  // Deepest 3 by x (most defensive = lowest x)
  const sortedByX  = [...players].sort((a, b) => a.x - b.x);
  const n3 = Math.min(3, sortedByX.length);
  const defensiveX = sortedByX.slice(0, n3).reduce((s, p) => s + p.x, 0) / n3;
  const attackingX = sortedByX.slice(-n3).reduce((s, p) => s + p.x, 0) / n3;

  // Anomalies: > 1.5 std devs from centroid
  const spacingAnomalies = players
    .map((p, i) => ({ p, d: dists[i] }))
    .filter(({ d }) => d > mean + 1.5 * stdDev)
    .map(({ p, d }) => ({ name: p.playerName ?? '—', x: p.x, y: p.y, gap: Math.round(d) }))
    .slice(0, 3);

  return {
    side,
    centroidX: Math.round(cX * 10) / 10,
    centroidY: Math.round(cY * 10) / 10,
    compactness, width: Math.round(width * 10) / 10, depth: Math.round(depth * 10) / 10,
    defensiveX: Math.round(defensiveX * 10) / 10,
    attackingX: Math.round(attackingX * 10) / 10,
    spacingAnomalies,
  };
}

/**
 * Detect overload zones across a 3×3 pitch grid (col=LEFT/CENTER/RIGHT, row=DEF/MID/ATK).
 */
export function computeOverloads(positions: TacticalBoardData['positions']): OverloadZone[] {
  const COLS = ['LEFT', 'CENTER', 'RIGHT'] as const;
  const ROWS = ['DEFENSIVE', 'MIDDLE', 'ATTACKING'] as const;
  const CW = 100 / 3, CRow = 100 / 3;
  const zones: OverloadZone[] = [];

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const xMin = c * CW, xMax = (c + 1) * CW;
      const yMin = r * CRow, yMax = (r + 1) * CRow;
      const inZone = (p: TacticalBoardData['positions'][number]) =>
        p.isStarter && p.x >= xMin && p.x < xMax && p.y >= yMin && p.y < yMax;
      const homeCount = positions.filter(p => p.side === 'HOME' && inZone(p)).length;
      const awayCount = positions.filter(p => p.side === 'AWAY' && inZone(p)).length;
      const diff      = homeCount - awayCount;
      const magnitude = Math.abs(diff);
      zones.push({
        col: COLS[c], row: ROWS[r],
        homeCount, awayCount,
        dominantSide: diff > 1 ? 'HOME' : diff < -1 ? 'AWAY' : 'BALANCED',
        magnitude,
      });
    }
  }
  return zones;
}

/**
 * Build formation shift series: per-5-min event-activity proxy for shape change.
 * Uses event distribution as a proxy (high activity bin → more open game).
 */
export function computeFormationShiftSeries(
  events: Array<{ occurredAtMin: number; kind: string; side: string }>,
  positions: TacticalBoardData['positions'],
  maxMinute: number,
): SpatialAnalysis['formationShiftSeries'] {
  if (maxMinute <= 0) return [];
  const BIN = 5;
  const bins = Math.ceil(maxMinute / BIN);

  const homePlayers = positions.filter(p => p.side === 'HOME' && p.isStarter);
  const awayPlayers = positions.filter(p => p.side === 'AWAY' && p.isStarter);
  const homeXs = homePlayers.map(p => p.x);
  const awayXs = awayPlayers.map(p => p.x);
  const homeWidth = homeXs.length > 1 ? Math.round(Math.max(...homeXs) - Math.min(...homeXs)) : 0;
  const awayWidth = awayXs.length > 1 ? Math.round(Math.max(...awayXs) - Math.min(...awayXs)) : 0;

  const homeEvt = new Array<number>(bins).fill(0);
  const awayEvt = new Array<number>(bins).fill(0);
  for (const e of events) {
    const bin = Math.min(bins - 1, Math.floor(e.occurredAtMin / BIN));
    if (e.side === 'HOME') homeEvt[bin]++;
    else awayEvt[bin]++;
  }
  const maxEvt = Math.max(1, ...homeEvt, ...awayEvt);

  return Array.from({ length: bins }, (_, i) => ({
    label: `${i * BIN}'`,
    homeWidth,
    awayWidth,
    homeCompactness: Math.round((1 - homeEvt[i] / maxEvt) * 100),
    awayCompactness: Math.round((1 - awayEvt[i] / maxEvt) * 100),
  }));
}

/**
 * Top-level spatial bundle. Pure function — takes already-fetched data.
 */
export function computeSpatialAnalysis(
  positions: TacticalBoardData['positions'],
  events: Array<{ occurredAtMin: number; kind: string; side: string; pitchX: number | null; pitchY: number | null }>,
  maxMinute: number,
): SpatialAnalysis {
  return {
    heatmap:              computeHeatmap(positions),
    pressureMap:          computePressureMap(events, maxMinute),
    passingNetwork:       computePassingNetwork(positions),
    homeShape:            computeTeamShape(positions, 'HOME'),
    awayShape:            computeTeamShape(positions, 'AWAY'),
    overloadZones:        computeOverloads(positions),
    formationShiftSeries: computeFormationShiftSeries(events, positions, maxMinute),
  };
}

// ── Phase 18 — Predictive Intelligence (pure, no DB) ─────────────────────────

/**
 * Predict next-window momentum direction using dominance slope + current index.
 * Returns normalised slope (-1…+1) and a direction call with confidence.
 */
export function predictMomentumShift(
  momentum:        { index: number; notes: string[] },
  dominanceSeries: DominanceWindow[],
  liveMinute:      number | null,
): PredictiveIntelligence['momentumForecast'] {
  void liveMinute; // reserved for future minute-weighting
  const recent = dominanceSeries.slice(-4);

  if (recent.length < 2) {
    return {
      direction: 'STABLE', confidence: 0.3, slope: 0,
      note: 'Insufficient match data for momentum forecast.',
    };
  }

  // Least-squares slope on homeScore (0-100; 50 = level)
  const n    = recent.length;
  const xs   = recent.map((_, i) => i);
  const ys   = recent.map(w => w.homeScore);
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
  const sumX2 = xs.reduce((s, x) => s + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  const rawSlope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;

  // Normalise: max expected change per bin ≈ 10 points
  const normSlope    = Math.max(-1, Math.min(1, rawSlope / 10));
  const effective    = normSlope + momentum.index * 0.2;
  const direction: 'HOME' | 'AWAY' | 'STABLE' =
    effective > 0.1 ? 'HOME' : effective < -0.1 ? 'AWAY' : 'STABLE';

  const dataConf  = Math.min(1, n / 4);
  const slopeConf = Math.min(1, Math.abs(normSlope) * 2);
  const confidence = Math.min(0.95, Math.round((0.4 + dataConf * 0.3 + slopeConf * 0.3) * 100) / 100);

  const noteMap: Record<string, string> = {
    HOME:   `Home team building momentum — ${momentum.notes[0] ?? 'increasing pressure in recent minutes'}.`,
    AWAY:   `Away team seizing control — ${momentum.notes[0] ?? 'momentum shifting toward visitors'}.`,
    STABLE: 'Match is evenly contested with no clear momentum shift.',
  };

  return { direction, confidence, slope: Math.round(normSlope * 100) / 100, note: noteMap[direction] };
}

/**
 * Predict goal probability (0-100) and which side is the likely scorer
 * in the next window based on shots, corners, momentum, and game phase.
 */
export function predictGoalWindow(
  timelineSummary: TimelineSummary,
  momentum:        { index: number; notes: string[] },
  liveMinute:      number | null,
): PredictiveIntelligence['goalThreat'] {
  const minute  = liveMinute ?? 45;
  const drivers: string[] = [];
  let prob = 20;

  if (timelineSummary.shotsOnTarget > 0) {
    prob += Math.min(25, timelineSummary.shotsOnTarget * 5);
    drivers.push(`${timelineSummary.shotsOnTarget} shots on target`);
  }
  if (timelineSummary.corners >= 3) {
    prob += Math.min(10, timelineSummary.corners * 2);
    drivers.push(`${timelineSummary.corners} corners awarded`);
  }

  const momEffect = Math.abs(momentum.index) * 15;
  prob += momEffect;
  if (Math.abs(momentum.index) > 0.3) {
    drivers.push(`Strong momentum index (${momentum.index.toFixed(2)})`);
  }

  if (minute >= 70) {
    prob += 10;
    drivers.push('Late-game pressure window');
  } else if (minute >= 40 && minute <= 50) {
    prob += 5;
    drivers.push('End-of-half pressure zone');
  }

  if (timelineSummary.shots >= 5 && timelineSummary.goals === 0) {
    prob += 8;
    drivers.push('High shot volume with no conversion — due for breakthrough');
  }

  const threatSide: 'HOME' | 'AWAY' | 'BALANCED' =
    momentum.index > 0.2 ? 'HOME' : momentum.index < -0.2 ? 'AWAY' : 'BALANCED';

  const windowMin = Math.min(10, Math.max(1, 90 - minute));

  return {
    probability: Math.min(90, Math.max(5, Math.round(prob))),
    threatSide,
    windowMin,
    drivers: drivers.slice(0, 4),
  };
}

/**
 * Forecast which players are approaching fatigue peak and when risk will crest.
 */
export function predictFatigueEscalation(
  fatigueIndicators: FatigueRow[],
  liveMinute:        number | null,
): PredictiveIntelligence['fatigueRisk'] {
  const minute = liveMinute ?? 45;

  if (fatigueIndicators.length === 0) {
    return { peakRisk: 'LOW', riskyCount: 0, riskPlayers: [], peakMinute: null };
  }

  const risky    = fatigueIndicators.filter(p => p.riskLevel !== 'LOW');
  const highRisk = fatigueIndicators.filter(p => p.riskLevel === 'HIGH');

  const riskPlayers = risky
    .slice(0, 5)
    .map(p => ({ name: p.name, fatigueIndex: p.fatigueIndex, minutesPlayed: p.minutesPlayed }));

  const peakRisk: 'HIGH' | 'MEDIUM' | 'LOW' =
    highRisk.length > 0 ? 'HIGH' : risky.length > 0 ? 'MEDIUM' : 'LOW';

  let peakMinute: number | null = null;
  if (peakRisk !== 'LOW' && minute > 0) {
    if (minute < 70) {
      const avgFatigue = fatigueIndicators.reduce((s, p) => s + p.fatigueIndex, 0) / fatigueIndicators.length;
      const rate       = avgFatigue / minute;
      const minsTo80   = rate > 0 ? (80 - avgFatigue) / rate : 30;
      peakMinute = Math.min(90, Math.round(minute + Math.max(0, minsTo80)));
    } else {
      peakMinute = Math.min(90, minute + 5);
    }
  }

  return { peakRisk, riskyCount: risky.length, riskPlayers, peakMinute };
}

/**
 * Predict counter-attack threat based on spatial overloads,
 * team shape depth, and transition event frequency.
 */
export function predictCounterThreat(
  spatialAnalysis: SpatialAnalysis,
  momentum:        { index: number; notes: string[] },
  timelineSummary: TimelineSummary,
): PredictiveIntelligence['counterThreat'] {
  let score = 0;

  // Dominant team pushed high → bigger space to counter into
  const attackingShape = momentum.index >= 0 ? spatialAnalysis.homeShape : spatialAnalysis.awayShape;
  if (attackingShape.centroidX > 60)      score += 30;
  else if (attackingShape.centroidX > 50) score += 15;

  // Defending shape width > 60 = stretched
  const defendingShape = momentum.index >= 0 ? spatialAnalysis.awayShape : spatialAnalysis.homeShape;
  if (defendingShape.width > 60) score += 20;
  if (defendingShape.compactness < 30) score += 20;

  // Fouls = quick restarts
  if (timelineSummary.fouls > 8) score += 15;

  // Direct attempts without corners = fast breaks
  if (timelineSummary.shots > 4 && timelineSummary.corners < 3) score += 15;

  score = Math.min(100, score);
  const level: 'HIGH' | 'MEDIUM' | 'LOW' =
    score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';

  // Weakest attacking overload zone → likely channel
  let likelyZone: 'LEFT' | 'CENTER' | 'RIGHT' | null = null;
  if (level !== 'LOW') {
    const atkZones = spatialAnalysis.overloadZones.filter(z => z.row === 'ATTACKING');
    const weakest  = atkZones.reduce<OverloadZone | null>((best, z) =>
      best === null || z.magnitude < best.magnitude ? z : best, null);
    if (weakest) likelyZone = weakest.col;
  }

  const noteMap: Record<string, string> = {
    HIGH:   'High counter-attack risk — compressed defensive shape and forward-heavy deployment.',
    MEDIUM: 'Moderate counter threat — monitor transition zones and defensive compactness.',
    LOW:    'Counter-attack threat is minimal — solid defensive positioning.',
  };

  return { level, likelyZone, note: noteMap[level] };
}

/**
 * Detect signs of tactical shape collapse: spacing anomalies, overloads,
 * fatigue clusters, and compactness breakdown.
 */
export function detectShapeCollapse(
  spatialAnalysis:   SpatialAnalysis,
  momentum:          { index: number },
  fatigueIndicators: FatigueRow[],
): PredictiveIntelligence['shapeCollapse'] {
  const indicators: string[] = [];
  let score = 0;

  const totalAnomalies = spatialAnalysis.homeShape.spacingAnomalies.length
    + spatialAnalysis.awayShape.spacingAnomalies.length;
  if (totalAnomalies > 0) {
    score += totalAnomalies * 15;
    indicators.push(`${totalAnomalies} spacing anomal${totalAnomalies === 1 ? 'y' : 'ies'} detected`);
  }

  if (spatialAnalysis.homeShape.width > 70 || spatialAnalysis.awayShape.width > 70) {
    score += 20;
    indicators.push('Overstretched team width (>70% of pitch)');
  }

  if (spatialAnalysis.homeShape.compactness < 25 || spatialAnalysis.awayShape.compactness < 25) {
    score += 20;
    indicators.push('Poor midfield compactness — gaps present');
  }

  const highFatigue = fatigueIndicators.filter(p => p.riskLevel === 'HIGH');
  if (highFatigue.length >= 3) {
    score += 20;
    indicators.push(`${highFatigue.length} players at high fatigue — shape may fragment`);
  } else if (highFatigue.length > 0) {
    score += 10;
    indicators.push(`${highFatigue.length} player(s) at high fatigue`);
  }

  if (Math.abs(momentum.index) > 0.4) {
    score += 10;
    indicators.push('Sustained pressure threatening shape integrity');
  }

  const bigOverloads = spatialAnalysis.overloadZones.filter(z => z.magnitude >= 3);
  if (bigOverloads.length > 0) {
    score += bigOverloads.length * 8;
    indicators.push(`${bigOverloads.length} severe overload zone(s) being exploited`);
  }

  score = Math.min(100, score);
  const risk: 'HIGH' | 'MEDIUM' | 'LOW' =
    score >= 60 ? 'HIGH' : score >= 35 ? 'MEDIUM' : 'LOW';

  return { risk, score, indicators: indicators.slice(0, 4) };
}

/**
 * Forecast possession trajectory over the next few minutes using
 * dominance trend as a leading indicator.
 */
export function predictPossessionSwing(
  possession:      { ourPct: number },
  dominanceSeries: DominanceWindow[],
): PredictiveIntelligence['possessionSwing'] {
  const currentPct = Math.round(possession.ourPct);
  const recent     = dominanceSeries.slice(-3);

  if (recent.length < 2) {
    return { currentPct, forecastPct: currentPct, trend: 'STABLE', confidence: 0.3 };
  }

  const avgDom       = recent.reduce((s, w) => s + w.homeScore, 0) / recent.length;
  const slope        = (recent[recent.length - 1].homeScore - recent[0].homeScore) / (recent.length - 1);
  const dominanceBias = (avgDom - 50) / 50;  // -1…+1
  const slopeBias     = slope / 20;            // normalised
  const totalBias     = dominanceBias * 0.6 + slopeBias * 0.4;

  const swingAmount  = Math.round(totalBias * 5);
  const forecastPct  = Math.max(10, Math.min(90, currentPct + swingAmount));
  const trend: 'GAINING' | 'LOSING' | 'STABLE' =
    forecastPct > currentPct + 2 ? 'GAINING' :
    forecastPct < currentPct - 2 ? 'LOSING' : 'STABLE';

  const confidence = Math.min(0.9,
    Math.round((0.3 + Math.min(1, recent.length / 3) * 0.3 + Math.min(1, Math.abs(totalBias)) * 0.4) * 100) / 100,
  );

  return { currentPct, forecastPct, trend, confidence };
}

/**
 * Top-level predictive bundle combinator. Pure function — takes already-computed data.
 */
export function computePredictiveIntelligence(
  momentum:          { index: number; notes: string[] },
  possession:        { ourPct: number },
  dominanceSeries:   DominanceWindow[],
  timelineSummary:   TimelineSummary,
  fatigueIndicators: FatigueRow[],
  spatialAnalysis:   SpatialAnalysis,
  liveMinute:        number | null,
): PredictiveIntelligence {
  return {
    momentumForecast: predictMomentumShift(momentum, dominanceSeries, liveMinute),
    goalThreat:       predictGoalWindow(timelineSummary, momentum, liveMinute),
    fatigueRisk:      predictFatigueEscalation(fatigueIndicators, liveMinute),
    counterThreat:    predictCounterThreat(spatialAnalysis, momentum, timelineSummary),
    shapeCollapse:    detectShapeCollapse(spatialAnalysis, momentum, fatigueIndicators),
    possessionSwing:  predictPossessionSwing(possession, dominanceSeries),
  };
}

// ── Deterministic coach recommendations from match data ─────────────────────

function buildCoachRecommendations(
  ts:      TimelineSummary,
  mom:     { index: number; notes: string[] },
  ratings: PlayerRatingRow[],
  fatigue: FatigueRow[],
): CoachRecommendation[] {
  const recs: CoachRecommendation[] = [];

  if (mom.index < -0.3) {
    recs.push({
      priority: 'HIGH', area: 'Momentum',
      finding:  'Opposition holds significant momentum — index ' + mom.index.toFixed(2),
      action:   'Compact the midfield block. Switch to lower-block shape to reset the game.',
    });
  } else if (mom.index > 0.4) {
    recs.push({
      priority: 'MEDIUM', area: 'Momentum',
      finding:  'We hold positive momentum — index ' + mom.index.toFixed(2),
      action:   'Maintain high press and exploit wide channels before opposition adjusts.',
    });
  }

  if (ts.shotsOnTarget > 3 && ts.goals === 0) {
    recs.push({
      priority: 'HIGH', area: 'Attack',
      finding:  `${ts.shotsOnTarget} shots on target with no goal — conversion issue`,
      action:   'Adjust striker positioning. Target far-post runs and cut-backs from wide areas.',
    });
  }

  if (ts.yellowCards >= 2) {
    recs.push({
      priority: 'HIGH', area: 'Discipline',
      finding:  `${ts.yellowCards} yellow cards — team at risk of a red card`,
      action:   'Reduce aerial contest frequency. Track opponents without lunging.',
    });
  }

  if (ts.corners >= 4) {
    recs.push({
      priority: 'MEDIUM', area: 'Set Pieces',
      finding:  `${ts.corners} corners earned — set piece opportunity`,
      action:   'Deploy near-post flick routine. Rotate corner delivery to exploit defensive shape.',
    });
  }

  const highFatigue = fatigue.filter(r => r.riskLevel === 'HIGH');
  if (highFatigue.length > 0) {
    recs.push({
      priority: 'HIGH', area: 'Fitness',
      finding:  `${highFatigue.length} player(s) at high fatigue risk: ${highFatigue.map(r => r.name.split(' ').pop() ?? r.name).join(', ')}`,
      action:   'Consider substitution. Reduce high-intensity pressing duties for affected players.',
    });
  }

  const lowRated = ratings.filter(r => r.minutesPlayed >= 30 && r.rating < 5.5);
  if (lowRated.length > 0) {
    recs.push({
      priority: 'MEDIUM', area: 'Performance',
      finding:  `${lowRated.length} player(s) underperforming (rating <5.5): ${lowRated.map(r => r.name.split(' ').pop() ?? r.name).join(', ')}`,
      action:   'Positional adjustment or substitution. Target their zones with increased support runs.',
    });
  }

  if (recs.length === 0) {
    recs.push({
      priority: 'LOW', area: 'General',
      finding:  'No critical issues detected',
      action:   'Maintain current shape and intensity. Continue pressing high and recycling possession.',
    });
  }

  return recs.sort((a, b) => {
    const order: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return order[a.priority] - order[b.priority];
  });
}

// ── Main DB query + composition ────────────────────────────────────────────────

export async function getLiveIntelligence(
  matchId: string,
  clubId:  string,
): Promise<LiveIntelligenceBundle> {
  // ── 1. Match + lineups ─────────────────────────────────────────────────
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true, clubId: true, status: true, liveMinute: true,
      homeTeam: true, awayTeam: true, homeScore: true, awayScore: true,
      formationHome: true, formationAway: true, possession: true,
      lineups: { select: { side: true, formation: true, positions: true } },
    },
  });
  if (!match)              throw new NotFoundError('Match');
  if (match.clubId !== clubId) throw new ForbiddenError();

  // ── 2. Timeline events ─────────────────────────────────────────────────
  const rawTimeline = await prisma.matchTimeline.findMany({
    where:   { matchId, isDeleted: false },
    orderBy: { occurredAtMin: 'asc' },
    // Phase 17: pitchX/pitchY added for spatial pressure map
    select:  { occurredAtMin: true, kind: true, side: true, pitchX: true, pitchY: true },
  });

  // ── 3. Phase Q PlayerMatchStats + player info ──────────────────────────
  const rawStats = await prisma.playerMatchStats.findMany({
    where: { matchId },
    include: {
      player: {
        select: {
          id: true, firstName: true, lastName: true,
          position: true, number: true,
        },
      },
    },
  });

  // Fallback: Phase B PlayerMatchStat if Phase Q empty
  const legacyStats = rawStats.length === 0
    ? await prisma.playerMatchStat.findMany({
        where: { matchId },
        include: {
          player: {
            select: { id: true, firstName: true, lastName: true, position: true, number: true },
          },
        },
      })
    : [];

  // ── 4. WorkloadRecord — ACWR via latest weekStart per player ──────────
  const playerIds = rawStats.length > 0
    ? rawStats.map(s => s.playerId)
    : legacyStats.map(s => s.playerId);

  const workloadMap = new Map<string, number>();
  if (playerIds.length > 0) {
    const workloads = await prisma.workloadRecord.findMany({
      where:   { playerId: { in: playerIds } },
      orderBy: { weekStart: 'desc' },
      select:  { playerId: true, acwr: true },
    });
    for (const w of workloads) {
      if (!workloadMap.has(w.playerId)) workloadMap.set(w.playerId, w.acwr);
    }
  }

  // ── 5. Match Brain (Phase F — reused) ─────────────────────────────────
  let brain: Awaited<ReturnType<typeof buildMatchBrain>> | null = null;
  try { brain = await buildMatchBrain(matchId, clubId); } catch (_) { /* graceful */ }

  // ── 6. Timeline summary ────────────────────────────────────────────────
  const kc = (k: string) => rawTimeline.filter(e => e.kind === k).length;
  const timelineSummary: TimelineSummary = {
    totalEvents:   rawTimeline.length,
    goals:         kc('GOAL') + kc('OWN_GOAL') + kc('PENALTY_SCORED'),
    shotsOnTarget: kc('SHOT_ON_TARGET'),
    shots:         kc('SHOT') + kc('SHOT_ON_TARGET') + kc('SHOT_OFF_TARGET'),
    corners:       kc('CORNER'),
    fouls:         kc('FOUL'),
    yellowCards:   kc('YELLOW_CARD') + kc('SECOND_YELLOW'),
    redCards:      kc('RED_CARD'),
    byMinute:      rawTimeline.map(e => ({ minute: e.occurredAtMin, kind: e.kind, side: e.side })),
  };

  // ── 7. Player ratings ──────────────────────────────────────────────────
  const playerRatings: PlayerRatingRow[] = [];

  if (rawStats.length > 0) {
    for (const s of rawStats) {
      const stored   = s.ratingFamilista;
      const computed = stored != null
        ? stored
        : computePlayerRating({
            goals: s.goals, assists: s.assists, shotsOnTarget: s.shotsOnTarget,
            xa: s.xa, foulsCommitted: s.foulsCommitted, yellowCards: s.yellowCards,
            redCards: s.redCards, tackles: s.tackles, tacklesWon: s.tacklesWon,
            passes: s.passes, passAccuracy: s.passAccuracy, minutesPlayed: s.minutesPlayed,
          });
      playerRatings.push({
        playerId:         s.playerId,
        name:             `${s.player.firstName} ${s.player.lastName}`.trim(),
        position:         String(s.player.position ?? ''),
        jerseyNumber:     s.player.number ?? null,
        minutesPlayed:    s.minutesPlayed,
        rating:           computed,
        goals:            s.goals,
        assists:          s.assists,
        xg:               Math.round(s.xg * 100) / 100,
        xa:               Math.round(s.xa * 100) / 100,
        keyPasses:        s.keyPasses,
        tacklesWon:       s.tacklesWon,
        pressures:        s.pressures,
        isRatingComputed: stored == null,
      });
    }
  } else {
    for (const s of legacyStats) {
      const computed = s.rating != null
        ? s.rating
        : computePlayerRating({
            goals: s.goals, assists: s.assists, shotsOnTarget: 0,
            xa: 0, foulsCommitted: 0, yellowCards: 0, redCards: 0,
            tackles: s.tackles, tacklesWon: 0, passes: s.passes,
            passAccuracy: s.passAccuracy, minutesPlayed: s.minutesPlayed,
          });
      playerRatings.push({
        playerId: s.playerId,
        name: `${s.player.firstName} ${s.player.lastName}`.trim(),
        position: String(s.player.position ?? ''),
        jerseyNumber: s.player.number ?? null,
        minutesPlayed: s.minutesPlayed,
        rating: computed,
        goals: s.goals, assists: s.assists, xg: 0, xa: 0,
        keyPasses: 0, tacklesWon: 0, pressures: 0,
        isRatingComputed: s.rating == null,
      });
    }
  }
  playerRatings.sort((a, b) => b.rating - a.rating);

  // ── 8. Dominance series ────────────────────────────────────────────────
  const maxMin = rawTimeline.length > 0
    ? Math.max(match.liveMinute ?? 0, rawTimeline[rawTimeline.length - 1]?.occurredAtMin ?? 0)
    : (match.liveMinute ?? 45);
  const dominanceSeries = buildDominanceSeries(
    rawTimeline.map(e => ({ occurredAtMin: e.occurredAtMin, kind: e.kind, side: e.side as 'HOME' | 'AWAY' })),
    Math.max(maxMin, 45),
  );

  // ── 9. Fatigue indicators ─────────────────────────────────────────────
  const fatigueIndicators: FatigueRow[] = [];
  if (rawStats.length > 0) {
    for (const s of rawStats) {
      const acwr        = workloadMap.get(s.playerId) ?? null;
      const fi          = computeFatigueIndex(s.minutesPlayed, s.pressures, s.pressuresSuccessful, acwr);
      const successPct  = s.pressures > 0
        ? Math.round((s.pressuresSuccessful / s.pressures) * 100)
        : 100;
      fatigueIndicators.push({
        playerId:        s.playerId,
        name:            `${s.player.firstName} ${s.player.lastName}`.trim(),
        position:        String(s.player.position ?? ''),
        minutesPlayed:   s.minutesPlayed,
        fatigueIndex:    fi,
        pressureSuccess: successPct,
        acwr,
        riskLevel:       fi >= 80 ? 'HIGH' : fi >= 60 ? 'MEDIUM' : 'LOW',
      });
    }
    fatigueIndicators.sort((a, b) => b.fatigueIndex - a.fatigueIndex);
  }

  // ── 10. Tactical board ────────────────────────────────────────────────
  const ratingById = new Map(playerRatings.map(r => [r.playerId, r.rating]));
  const boardPositions: TacticalBoardData['positions'] = [];
  for (const lineup of match.lineups) {
    const pos = Array.isArray(lineup.positions) ? lineup.positions as Array<Record<string, unknown>> : [];
    for (const p of pos) {
      boardPositions.push({
        playerId:    typeof p.playerId === 'string' ? p.playerId : null,
        playerName:  typeof p.name === 'string' ? p.name : null,
        jerseyNumber:typeof p.jerseyNumber === 'number' ? p.jerseyNumber : null,
        position:    typeof p.position === 'string' ? p.position : null,
        x:           typeof p.x === 'number' ? p.x : 50,
        y:           typeof p.y === 'number' ? p.y : 30,
        isStarter:   typeof p.isStarter === 'boolean' ? p.isStarter : true,
        side:        String(lineup.side),
        rating:      typeof p.playerId === 'string' ? (ratingById.get(p.playerId) ?? null) : null,
      });
    }
  }
  const tacticalBoard: TacticalBoardData = {
    formationHome: match.formationHome ?? (match.lineups.find(l => l.side === 'HOME')?.formation ?? null),
    formationAway: match.formationAway ?? (match.lineups.find(l => l.side === 'AWAY')?.formation ?? null),
    positions:     boardPositions,
    possession:    brain?.possession.ourPct ?? (match.possession ?? 50),
  };

  // ── 11. Momentum + possession (brain or match fallback) ───────────────
  const momentum   = brain?.momentum  ?? { index: 0, windowSec: 300, notes: [] as string[] };
  const possession = brain?.possession ?? { ourPct: match.possession ?? 50, windowSec: 300 };

  // ── 12. Coach recommendations ─────────────────────────────────────────
  const coachRecommendations = buildCoachRecommendations(
    timelineSummary, momentum, playerRatings, fatigueIndicators,
  );

  // ── Phase 17: Spatial analysis ────────────────────────────────────────────
  const spatialAnalysis = computeSpatialAnalysis(
    boardPositions,
    rawTimeline,          // now includes pitchX / pitchY
    Math.max(maxMin, 45),
  );

  // ── Phase 18: Predictive intelligence ────────────────────────────────────
  const predictions = computePredictiveIntelligence(
    momentum, possession, dominanceSeries, timelineSummary,
    fatigueIndicators, spatialAnalysis, match.liveMinute,
  );

  return {
    matchId:  match.id, clubId, status: match.status, liveMinute: match.liveMinute,
    score:    { home: match.homeScore, away: match.awayScore },
    homeTeam: match.homeTeam, awayTeam: match.awayTeam,
    formationHome: match.formationHome, formationAway: match.formationAway,
    computedAt:    new Date().toISOString(),
    timelineSummary, momentum, possession,
    tacticalBoard, coachRecommendations, playerRatings, dominanceSeries, fatigueIndicators,
    spatialAnalysis, predictions,
  };
}
