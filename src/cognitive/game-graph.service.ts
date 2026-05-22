// Familista — Realtime Cognitive Game Graph (Phase L)
// ─────────────────────────────────────────────────────────────────────────
// Snapshot tables — each row is one (matchId, monotonicMs) graph. Indexed
// for fast SSE-driven reads. All payloads are JSON to keep cardinality
// bounded and the writer cost O(1).
//
// Derivations are PURE FUNCTIONS in the metric helpers below; persistence
// is best-effort.

import { CognitiveInfluenceScore, DynamicThreatMap, GameGraph, PassingNetworkGraph, Prisma, SpatialPressureGraph } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';

export interface GraphActor {
  userId: string;
  clubId: string;
  role?:  string;
}

async function assertMatch(matchId: string, clubId: string): Promise<void> {
  const m = await prisma.match.findUnique({ where: { id: matchId }, select: { clubId: true } });
  if (!m)                   throw new NotFoundError('Match');
  if (m.clubId !== clubId)  throw new ForbiddenError();
}

// ── Game graph (generic) ────────────────────────────────────────────────

export interface RecordGameGraphDto {
  matchId:     string;
  monotonicMs: number;
  nodes:       Prisma.InputJsonValue;
  edges:       Prisma.InputJsonValue;
}

export async function recordGameGraph(actor: GraphActor, dto: RecordGameGraphDto): Promise<GameGraph> {
  await assertMatch(dto.matchId, actor.clubId);
  return prisma.gameGraph.create({
    data: {
      clubId:      actor.clubId,
      matchId:     dto.matchId,
      monotonicMs: BigInt(dto.monotonicMs),
      nodes:       dto.nodes,
      edges:       dto.edges,
    },
  });
}

export async function listGameGraphs(actor: GraphActor, matchId: string, opts: { fromMs?: number; toMs?: number; limit?: number } = {}): Promise<GameGraph[]> {
  await assertMatch(matchId, actor.clubId);
  return prisma.gameGraph.findMany({
    where: {
      matchId,
      ...(opts.fromMs ? { monotonicMs: { gte: BigInt(opts.fromMs) } } : {}),
      ...(opts.toMs   ? { monotonicMs: { lte: BigInt(opts.toMs) } }   : {}),
    },
    orderBy: { monotonicMs: 'asc' },
    take:    Math.min(opts.limit ?? 200, 2000),
  });
}

// ── Specialised graphs ──────────────────────────────────────────────────

export async function recordPressureGraph(actor: GraphActor, matchId: string, monotonicMs: number, field: Prisma.InputJsonValue, windowMs = 5000): Promise<SpatialPressureGraph> {
  await assertMatch(matchId, actor.clubId);
  return prisma.spatialPressureGraph.create({
    data: { clubId: actor.clubId, matchId, monotonicMs: BigInt(monotonicMs), field, windowMs },
  });
}

export async function recordPassingNetwork(actor: GraphActor, matchId: string, monotonicMs: number, network: Prisma.InputJsonValue, windowMs = 300000): Promise<PassingNetworkGraph> {
  await assertMatch(matchId, actor.clubId);
  return prisma.passingNetworkGraph.create({
    data: { clubId: actor.clubId, matchId, monotonicMs: BigInt(monotonicMs), network, windowMs },
  });
}

export async function recordThreatMap(actor: GraphActor, matchId: string, monotonicMs: number, field: Prisma.InputJsonValue, windowMs = 60000): Promise<DynamicThreatMap> {
  await assertMatch(matchId, actor.clubId);
  return prisma.dynamicThreatMap.create({
    data: { clubId: actor.clubId, matchId, monotonicMs: BigInt(monotonicMs), field, windowMs },
  });
}

export async function recordInfluence(actor: GraphActor, matchId: string, monotonicMs: number, playerId: string, score: number, components?: Prisma.InputJsonValue): Promise<CognitiveInfluenceScore> {
  await assertMatch(matchId, actor.clubId);
  return prisma.cognitiveInfluenceScore.create({
    data: { clubId: actor.clubId, matchId, monotonicMs: BigInt(monotonicMs), playerId, score: Math.max(0, Math.min(1, score)), components: (components ?? Prisma.JsonNull) as Prisma.InputJsonValue },
  });
}

// ── Pure helpers (deterministic — usable in detectors / tests) ─────────

export const COG_GRAPH_VERSION = 'l1';

/** Compute a basic influence score from spatial occupation + passing involvement. */
export function influenceFor(input: { passes: number; touches: number; spaceCovered: number; sprints: number }): { value: number; version: string } {
  const v = Math.min(1, 0.3 * Math.log10(1 + input.passes)
                       + 0.3 * Math.log10(1 + input.touches)
                       + 0.2 * Math.min(1, input.spaceCovered / 5000)
                       + 0.2 * Math.min(1, input.sprints / 20));
  return { value: Number(v.toFixed(3)), version: COG_GRAPH_VERSION };
}

/** Compute a per-cell pressure field given player positions + opp positions. */
export function pressureField(home: Array<{ x: number; y: number }>, away: Array<{ x: number; y: number }>, width = 105, height = 68, gx = 20, gy = 12): number[][] {
  const cellW = width / gx, cellH = height / gy;
  const grid: number[][] = Array.from({ length: gy }, () => new Array(gx).fill(0));
  for (const h of home) {
    for (const a of away) {
      const cx = Math.min(gx - 1, Math.max(0, Math.floor(((h.x + a.x) / 2) / cellW)));
      const cy = Math.min(gy - 1, Math.max(0, Math.floor(((h.y + a.y) / 2) / cellH)));
      const d  = Math.hypot(h.x - a.x, h.y - a.y);
      const intensity = Math.exp(-d / 8);
      grid[cy][cx] += intensity;
    }
  }
  return grid;
}
