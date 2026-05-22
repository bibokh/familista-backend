// Familista — Realtime Match Brain (Phase F)
// ─────────────────────────────────────────────────────────────────────────
// The "match brain" is the higher-order projection over TacticalState.
// Where TacticalState answers "what's on the pitch RIGHT NOW", the brain
// answers questions about *trajectory*:
//
//   - Live event graph    : causal chains between recent events
//   - Tactical momentum   : score velocity + sprint density delta
//   - Possession state    : derived from timeline (kept events)
//   - Pressure zones      : spatial heatmap of recent opponent activity
//
// All read-only, pure functions. ONE call to buildMatchBrain() = ONE call
// to tactical-state.getState() + a few extra bounded reads. Safe to call
// per /brain endpoint hit; subscribers should prefer the SSE channel.

import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { getState, TacticalState } from './tactical-state';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type CausalRelation =
  | 'AFTER'           // simple temporal succession
  | 'TRIGGERS'        // foul → free-kick, shot → corner, etc.
  | 'RESPONDS_TO'     // opponent shot → our save / our shot
  | 'CHAIN_OF_PLAY';  // pass cluster ending in shot

export interface LiveEventNode {
  id:        string;
  minute:    number;
  kind:      string;
  side:      'HOME' | 'AWAY';
  playerId?: string | null;
  x?:        number | null;
  y?:        number | null;
  /** Edges into this node from earlier nodes. */
  inEdges:   Array<{ from: string; rel: CausalRelation }>;
}

export interface LiveEventGraph {
  nodes:     LiveEventNode[];
  edges:     Array<{ from: string; to: string; rel: CausalRelation }>;
  /** The single most recent "chain" — useful for the panel headline. */
  lastChain: string[];
}

export interface MomentumState {
  /** -1.0 … +1.0 — positive = our side has momentum */
  index:           number;
  /** Window the index was computed over, in seconds. */
  windowSec:       number;
  /** Score delta inside the window. */
  scoreDelta:      number;
  /** Sprint count delta inside the window. */
  sprintDelta:     number;
  /** Opponent threat events inside the window. */
  threatAgainst:   number;
  /** Notes the panel can render. */
  notes:           string[];
}

export interface PossessionState {
  /** 0..100 — our possession % over the analysis window. */
  ourPct:        number;
  /** Time-weighted, based on kept events */
  windowSec:     number;
  /** Number of kept-possession transitions in the window. */
  transitions:   number;
  /** Last side known to have possession. */
  lastSide:      'HOME' | 'AWAY' | 'UNKNOWN';
}

export interface PressureZone {
  /** Cell centroid in 0..100 pitch coords. */
  x:        number;
  y:        number;
  /** Number of OPP events in the last window inside this cell. */
  density:  number;
  /** Mean recency in seconds (smaller = hotter zone). */
  recencyS: number;
}

export interface MatchBrain extends TacticalState {
  graph:        LiveEventGraph;
  momentum:     MomentumState;
  possession:   PossessionState;
  pressureZones: PressureZone[];
}

// ─────────────────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────────────────

const BRAIN_WINDOW_MS  = 5 * 60 * 1000;
const PRESSURE_GRID    = 10;             // 10 × 10 cells across 0..100 × 0..100

export async function buildMatchBrain(matchId: string, clubId: string): Promise<MatchBrain> {
  const state = await getState(matchId, clubId);

  // Bounded extra read — most-recent N timeline events with spatial info.
  // Tactical state already pulls 10; brain pulls up to 80 for the graph.
  const m = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, clubId: true, homeTeam: true, awayTeam: true, isHome: true },
  });
  if (!m)                     throw new NotFoundError('Match');
  if (m.clubId !== clubId)    throw new ForbiddenError();

  const timeline = await prisma.matchTimeline.findMany({
    where:   { matchId, isDeleted: false },
    orderBy: { createdAt: 'desc' },
    take:    80,
    select: {
      id: true, occurredAtMin: true, kind: true, side: true,
      primaryPlayerId: true, pitchX: true, pitchY: true, createdAt: true,
    },
  });

  const graph        = buildEventGraph(timeline);
  const momentum     = buildMomentum(timeline, state);
  const possession   = buildPossession(timeline);
  const pressureZones = buildPressureZones(timeline);

  return {
    ...state,
    graph,
    momentum,
    possession,
    pressureZones,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Event graph — causal chain extraction
// ─────────────────────────────────────────────────────────────────────────

const TRIGGERS: Record<string, string[]> = {
  FOUL:          ['FREE_KICK', 'PENALTY_AWARDED'],
  SHOT:          ['CORNER', 'GOAL_KICK', 'THROW_IN', 'GOAL', 'OWN_GOAL'],
  SHOT_ON_TARGET:['CORNER', 'GOAL', 'GOAL_KICK', 'SAVE'],
  SHOT_OFF_TARGET:['GOAL_KICK', 'CORNER'],
  CORNER:        ['SHOT', 'SHOT_ON_TARGET', 'SHOT_OFF_TARGET', 'GOAL'],
  PENALTY_AWARDED:['PENALTY_SCORED', 'PENALTY_MISSED'],
  RED_CARD:      ['SUBSTITUTION_IN', 'SUBSTITUTION_OUT'],
};

function buildEventGraph(timeline: Array<{
  id: string; occurredAtMin: number; kind: string; side: string;
  primaryPlayerId: string | null; pitchX: number | null; pitchY: number | null;
  createdAt: Date;
}>): LiveEventGraph {
  // Reverse to chronological for graph construction.
  const chrono = [...timeline].reverse();

  const nodes: LiveEventNode[] = chrono.map((e) => ({
    id:       e.id,
    minute:   e.occurredAtMin,
    kind:     e.kind,
    side:     e.side as 'HOME' | 'AWAY',
    playerId: e.primaryPlayerId,
    x:        e.pitchX,
    y:        e.pitchY,
    inEdges:  [],
  }));

  const edges: LiveEventGraph['edges'] = [];

  for (let i = 0; i < chrono.length; i++) {
    if (i === 0) continue;
    const cur  = chrono[i];
    const prev = chrono[i - 1];
    const prevMs = prev.createdAt.getTime();
    const curMs  = cur.createdAt.getTime();
    const dtSec  = (curMs - prevMs) / 1000;

    // Simple AFTER edge — temporal succession within 2 minutes.
    if (dtSec >= 0 && dtSec <= 120) {
      edges.push({ from: prev.id, to: cur.id, rel: 'AFTER' });
      nodes[i].inEdges.push({ from: prev.id, rel: 'AFTER' });
    }

    // TRIGGERS — if the prior event's kind is a known trigger of the
    // current event's kind, mark it.
    if ((TRIGGERS[prev.kind] ?? []).includes(cur.kind)) {
      edges.push({ from: prev.id, to: cur.id, rel: 'TRIGGERS' });
      nodes[i].inEdges.push({ from: prev.id, rel: 'TRIGGERS' });
    }

    // RESPONDS_TO — same window but on the opposite side.
    if (prev.side !== cur.side && dtSec <= 30) {
      edges.push({ from: prev.id, to: cur.id, rel: 'RESPONDS_TO' });
      nodes[i].inEdges.push({ from: prev.id, rel: 'RESPONDS_TO' });
    }
  }

  // CHAIN_OF_PLAY — find runs of same-side same-minute events ending in a SHOT/GOAL.
  const lastChain: string[] = [];
  for (let i = chrono.length - 1; i >= 0; i--) {
    const e = chrono[i];
    if (['GOAL','SHOT','SHOT_ON_TARGET','SHOT_OFF_TARGET'].includes(e.kind)) {
      lastChain.unshift(e.id);
      for (let j = i - 1; j >= 0; j--) {
        const p = chrono[j];
        if (p.side !== e.side) break;
        if (Math.abs((chrono[i].createdAt.getTime() - p.createdAt.getTime()) / 1000) > 90) break;
        lastChain.unshift(p.id);
        if (lastChain.length >= 6) break;
      }
      // Convert AFTER → CHAIN_OF_PLAY for the chain nodes.
      for (let k = 1; k < lastChain.length; k++) {
        edges.push({ from: lastChain[k - 1], to: lastChain[k], rel: 'CHAIN_OF_PLAY' });
      }
      break;
    }
  }

  return { nodes, edges, lastChain };
}

// ─────────────────────────────────────────────────────────────────────────
// Momentum
// ─────────────────────────────────────────────────────────────────────────

function buildMomentum(
  timeline: Array<{ kind: string; side: string; createdAt: Date }>,
  state: TacticalState,
): MomentumState {
  const cutoff = Date.now() - BRAIN_WINDOW_MS;
  const recent = timeline.filter((e) => e.createdAt.getTime() >= cutoff);

  const SCORING = new Set(['GOAL', 'PENALTY_SCORED']);
  const THREATS = new Set(['SHOT', 'SHOT_ON_TARGET', 'CORNER', 'PENALTY_AWARDED']);

  let scoreDelta    = 0;
  let threatFor     = 0;
  let threatAgainst = 0;
  for (const e of recent) {
    const ours = e.side === 'HOME';   // home = our team by convention; UI flips for away matches
    if (SCORING.has(e.kind)) scoreDelta += ours ? 1 : -1;
    if (THREATS.has(e.kind)) ours ? threatFor++ : threatAgainst++;
  }

  // Sprint delta — count CRITICAL/CAUTION players (proxy for opponent
  // pressure on us). Negative for us if we're under sustained load.
  const sprintingNow = state.players.filter((p) => p.sprint === 1).length;
  const fatigued     = state.players.filter((p) => p.alert === 'CRITICAL').length;
  const sprintDelta  = sprintingNow - fatigued * 2;

  // Combine — bounded to [-1, +1].
  const raw = (
      Math.tanh(scoreDelta)         * 0.50
    + Math.tanh((threatFor - threatAgainst) / 3) * 0.30
    + Math.tanh(sprintDelta / 5)    * 0.20
  );
  const index = Number(Math.max(-1, Math.min(1, raw)).toFixed(3));

  const notes: string[] = [];
  if (scoreDelta > 0) notes.push(`+${scoreDelta} goal advantage in window`);
  if (scoreDelta < 0) notes.push(`${scoreDelta} goal deficit in window`);
  if (threatAgainst > threatFor + 1) notes.push(`opponent threat ${threatAgainst} vs ${threatFor}`);
  if (fatigued > 0) notes.push(`${fatigued} player(s) at critical TAI`);
  if (notes.length === 0) notes.push('Neutral phase');

  return { index, windowSec: BRAIN_WINDOW_MS / 1000, scoreDelta, sprintDelta, threatAgainst, notes };
}

// ─────────────────────────────────────────────────────────────────────────
// Possession
// ─────────────────────────────────────────────────────────────────────────

const POSSESSION_KIND_OURS = new Set([
  'PASS', 'SHOT', 'SHOT_ON_TARGET', 'SHOT_OFF_TARGET',
  'CORNER', 'GOAL', 'PENALTY_AWARDED', 'PENALTY_SCORED',
]);
const POSSESSION_KIND_THEIRS = new Set([
  'FOUL_CONCEDED', 'TURNOVER', 'INTERCEPTION_AGAINST',
]);

function buildPossession(
  timeline: Array<{ kind: string; side: string; createdAt: Date }>,
): PossessionState {
  const cutoff = Date.now() - BRAIN_WINDOW_MS;
  const recent = [...timeline].filter((e) => e.createdAt.getTime() >= cutoff).reverse();

  let oursTicks = 0, theirsTicks = 0, transitions = 0;
  let lastSide: 'HOME' | 'AWAY' | 'UNKNOWN' = 'UNKNOWN';
  for (const e of recent) {
    let side: 'HOME' | 'AWAY' | 'UNKNOWN' = 'UNKNOWN';
    if (POSSESSION_KIND_OURS.has(e.kind))   side = e.side as 'HOME' | 'AWAY';
    if (POSSESSION_KIND_THEIRS.has(e.kind)) side = e.side === 'HOME' ? 'AWAY' : 'HOME';
    if (side === 'UNKNOWN') continue;
    if (lastSide !== 'UNKNOWN' && lastSide !== side) transitions++;
    if (side === 'HOME') oursTicks++; else theirsTicks++;
    lastSide = side;
  }

  const total = oursTicks + theirsTicks;
  const ourPct = total === 0 ? 50 : Math.round((oursTicks / total) * 100);

  return { ourPct, windowSec: BRAIN_WINDOW_MS / 1000, transitions, lastSide };
}

// ─────────────────────────────────────────────────────────────────────────
// Pressure zones
// ─────────────────────────────────────────────────────────────────────────

function buildPressureZones(
  timeline: Array<{ kind: string; side: string; pitchX: number | null; pitchY: number | null; createdAt: Date }>,
): PressureZone[] {
  const cutoff = Date.now() - BRAIN_WINDOW_MS;
  const oppEvents = timeline
    .filter((e) => e.createdAt.getTime() >= cutoff)
    .filter((e) => e.side === 'AWAY')
    .filter((e) => typeof e.pitchX === 'number' && typeof e.pitchY === 'number') as Array<{
      pitchX: number; pitchY: number; createdAt: Date;
    }>;

  if (oppEvents.length === 0) return [];

  const cellSize = 100 / PRESSURE_GRID;
  const cells: Record<string, { x: number; y: number; ts: number[] }> = {};

  for (const e of oppEvents) {
    const cx = Math.min(PRESSURE_GRID - 1, Math.max(0, Math.floor(e.pitchX / cellSize)));
    const cy = Math.min(PRESSURE_GRID - 1, Math.max(0, Math.floor(e.pitchY / cellSize)));
    const key = `${cx}:${cy}`;
    if (!cells[key]) cells[key] = { x: cx, y: cy, ts: [] };
    cells[key].ts.push(e.createdAt.getTime());
  }

  const now = Date.now();
  const out: PressureZone[] = Object.values(cells).map((c) => {
    const meanTs = c.ts.reduce((s, v) => s + v, 0) / c.ts.length;
    return {
      x:        Number(((c.x + 0.5) * cellSize).toFixed(1)),
      y:        Number(((c.y + 0.5) * cellSize).toFixed(1)),
      density:  c.ts.length,
      recencyS: Number(((now - meanTs) / 1000).toFixed(1)),
    };
  });

  // Sort: densest + most-recent first; cap to 12 cells.
  out.sort((a, b) => (b.density - a.density) || (a.recencyS - b.recencyS));
  return out.slice(0, 12);
}
