// Familista — Digital Twin Engine (Phase G)
// ─────────────────────────────────────────────────────────────────────────
// Replay-safe interpolation over persisted SpatialFrame anchors.
//
// Persistence cadence is ≤2 Hz (cognitive-engine.ts), so calling
// twinAt(t) for an arbitrary t lands between two anchors. We linearly
// interpolate per-player x/y/z/heading/hr/load. Categorical fields
// (alert level, sources) take the closer anchor's value.
//
// "Replay-safe" means: given identical inputs (DB state + t), the output
// is identical. No clock, no randomness, no caching.

import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import type { SpatialFrame, UniversalPlayerState } from './types';
import { getSportAdapter } from '../sports';

export interface TwinAtOptions {
  /** Server epoch ms to reconstruct at. */
  atMs:     number;
  /** Max search window backward when looking for the prior anchor. */
  maxLookbackMs?: number;
}

export async function twinAt(matchId: string, clubId: string, opts: TwinAtOptions): Promise<SpatialFrame | null> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: { id: true, clubId: true } });
  if (!match)                   throw new NotFoundError('Match');
  if (match.clubId !== clubId)  throw new ForbiddenError();

  const t = BigInt(opts.atMs);
  const max = opts.maxLookbackMs ?? 30 * 60_000;
  const min = BigInt(opts.atMs - max);

  const [before, after] = await Promise.all([
    prisma.spatialFrame.findFirst({
      where:   { matchId, monotonicMs: { lte: t, gte: min } },
      orderBy: { monotonicMs: 'desc' },
    }),
    prisma.spatialFrame.findFirst({
      where:   { matchId, monotonicMs: { gt: t } },
      orderBy: { monotonicMs: 'asc' },
    }),
  ]);
  if (!before && !after) return null;
  if (!after)  return rehydrate(before!);
  if (!before) return rehydrate(after);

  return interpolate(before, after, opts.atMs);
}

export async function listAnchors(matchId: string, clubId: string, opts: { fromMs?: number; toMs?: number; limit?: number } = {}) {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: { id: true, clubId: true } });
  if (!match)                   throw new NotFoundError('Match');
  if (match.clubId !== clubId)  throw new ForbiddenError();
  return prisma.spatialFrame.findMany({
    where: {
      matchId,
      ...(opts.fromMs ? { monotonicMs: { gte: BigInt(opts.fromMs) } } : {}),
      ...(opts.toMs   ? { monotonicMs: { lte: BigInt(opts.toMs)   } } : {}),
    },
    orderBy: { monotonicMs: 'asc' },
    take:    Math.min(opts.limit ?? 600, 5000),
    select:  { id: true, monotonicMs: true, sport: true, sources: true },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Interpolation
// ─────────────────────────────────────────────────────────────────────────

function rehydrate(row: { sport: string; monotonicMs: bigint; clubId: string; matchId: string; players: unknown; object: unknown; geometry: unknown; sources: unknown }): SpatialFrame {
  return {
    sport:       row.sport as SpatialFrame['sport'],
    clubId:      row.clubId,
    matchId:     row.matchId,
    monotonicMs: Number(row.monotonicMs),
    geometry:    (row.geometry as SpatialFrame['geometry']) ?? getSportAdapter(row.sport).geometry(),
    players:     (row.players as UniversalPlayerState[]) ?? [],
    object:      (row.object as SpatialFrame['object']) ?? null,
    sources:     (row.sources as SpatialFrame['sources']) ?? { visionCameras: 0, wearables: 0, sensorPackets: 0, biochemPatches: 0, interpolated: true },
  };
}

function interpolate(before: { sport: string; monotonicMs: bigint; clubId: string; matchId: string; players: unknown; object: unknown; geometry: unknown; sources: unknown }, after: { monotonicMs: bigint; players: unknown; object: unknown }, atMs: number): SpatialFrame {
  const t0 = Number(before.monotonicMs);
  const t1 = Number(after.monotonicMs);
  const alpha = t1 === t0 ? 0 : Math.max(0, Math.min(1, (atMs - t0) / (t1 - t0)));

  const beforePlayers = (before.players as UniversalPlayerState[]) ?? [];
  const afterPlayers  = (after.players as UniversalPlayerState[]) ?? [];
  const afterById = new Map(afterPlayers.map((p) => [p.playerId, p]));

  const players: UniversalPlayerState[] = beforePlayers.map((b) => {
    const a = afterById.get(b.playerId);
    if (!a) return { ...b, sources: ['INTERPOLATED'] };
    return {
      ...b,
      x:        lerpNullable(b.x, a.x, alpha),
      y:        lerpNullable(b.y, a.y, alpha),
      z:        lerpNullable(b.z ?? 0, a.z ?? 0, alpha),
      hr:       lerpNullable(b.hr, a.hr, alpha),
      vx:       lerpNullable(b.vx, a.vx, alpha),
      vy:       lerpNullable(b.vy, a.vy, alpha),
      heading:  lerpNullable(b.heading, a.heading, alpha),
      sprint:   alpha < 0.5 ? b.sprint ?? 0 : a.sprint ?? 0,
      alert:    alpha < 0.5 ? b.alert ?? 'OK' : a.alert ?? 'OK',
      sources:  ['INTERPOLATED'],
      confidence: lerpNullable(b.confidence ?? 0.5, a.confidence ?? 0.5, alpha) ?? 0.5,
    };
  });

  const beforeObject = before.object as SpatialFrame['object'];
  const afterObject  = after.object  as SpatialFrame['object'];
  const object: SpatialFrame['object'] = (beforeObject && afterObject)
    ? {
        x:  lerpNullable(beforeObject.x, afterObject.x, alpha),
        y:  lerpNullable(beforeObject.y, afterObject.y, alpha),
        z:  lerpNullable(beforeObject.z ?? 0, afterObject.z ?? 0, alpha),
        confidence: lerpNullable(beforeObject.confidence ?? 0.5, afterObject.confidence ?? 0.5, alpha) ?? 0.5,
      }
    : (beforeObject ?? afterObject ?? null);

  return {
    sport:       before.sport as SpatialFrame['sport'],
    clubId:      before.clubId,
    matchId:     before.matchId,
    monotonicMs: atMs,
    geometry:    (before.geometry as SpatialFrame['geometry']) ?? getSportAdapter(before.sport).geometry(),
    players,
    object,
    sources:     {
      visionCameras: 0, wearables: 0, sensorPackets: 0, biochemPatches: 0,
      interpolated:  true,
    },
  };
}

function lerpNullable(a: number | null | undefined, b: number | null | undefined, alpha: number): number | null {
  if (a == null && b == null) return null;
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Number((a + (b - a) * alpha).toFixed(3));
}
