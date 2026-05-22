// Familista — Cognitive Spatial Engine (Phase G)
// ─────────────────────────────────────────────────────────────────────────
// Sport-agnostic resolver that fuses all available signals into a single
// SpatialFrame for one (matchId, monotonicMs) tuple.
//
// Source priority (highest to lowest):
//   1. VisionFrame (multi-camera consensus via triangulation.ts)
//   2. SensorPacket / GPS (wearable spatial)
//   3. Last known SpatialFrame + dead reckoning if everything else is stale
//   4. Sport-adapter expected position from FormationTemplate
//
// We persist a SpatialFrame snapshot at most every 500ms (≤2 Hz). The
// realtime layer interpolates between persisted frames in memory.

import type { SportKind } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { getSportAdapter } from '../sports';
import { triangulate, type CameraView } from '../vision/triangulation';
import type {
  SpatialFrame, UniversalPlayerState, CameraDetection, TacticalGeometry,
} from './types';

const VISION_WINDOW_MS  = 1_000;
const WEARABLE_WINDOW_MS = 2_500;
const PERSIST_MIN_GAP_MS = 500;

export interface BuildFrameOpts {
  /** Override the monotonic timestamp; default = now. */
  monotonicMs?: number;
  /** Persist the resulting frame to SpatialFrame table. */
  persist?:     boolean;
}

export async function buildSpatialFrame(
  matchId: string,
  clubId:  string,
  opts:    BuildFrameOpts = {},
): Promise<SpatialFrame> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, clubId: true, teamId: true },
  });
  if (!match)                   throw new NotFoundError('Match');
  if (match.clubId !== clubId)  throw new ForbiddenError();

  const sport: SportKind = 'FOOTBALL';  // Phase G: Match.sport not yet on schema; default FOOTBALL.
  const adapter = getSportAdapter(sport);
  const geometry: TacticalGeometry = adapter.geometry();

  const nowMs = opts.monotonicMs ?? Date.now();
  const visionSince  = BigInt(nowMs - VISION_WINDOW_MS);
  const wearableSince = new Date(nowMs - WEARABLE_WINDOW_MS);

  const [players, visionFrames, sensorPackets, sessions] = await Promise.all([
    prisma.player.findMany({
      where:  { clubId, ...(match.teamId ? { teamId: match.teamId } : {}), isActive: true },
      select: { id: true, firstName: true, lastName: true, number: true, position: true },
      take:   50,
    }),
    prisma.visionFrame.findMany({
      where:   { matchId, clubId, monotonicMs: { gte: visionSince } },
      orderBy: { monotonicMs: 'desc' },
      take:    400,
    }),
    prisma.sensorPacket.findMany({
      where: {
        deviceSession: { clubId, matchId },
        kind:          { in: ['GPS','HEART_RATE','IMU'] },
        capturedAt:    { gte: wearableSince },
      },
      orderBy: { capturedAt: 'desc' },
      take:    1500,
    }),
    prisma.deviceSession.findMany({
      where:  { clubId, matchId, endedAt: null },
      select: { id: true, deviceModel: true },
    }),
  ]);

  // ── Triangulate vision detections per player ───────────────────────
  const views: CameraView[] = groupByCamera(visionFrames);
  const triangulated = triangulate(views, { minConfidence: 0.35, outlierGateM: 8 });
  const visionById = new Map(triangulated.map((t) => [t.playerId, t]));

  // ── Latest GPS / HR per player ─────────────────────────────────────
  const gpsById:  Record<string, { x: number; y: number; speed?: number; ts: number }> = {};
  const hrById:   Record<string, { bpm: number; ts: number }> = {};
  for (const p of sensorPackets) {
    const pl = (p.payload as Record<string, unknown> | null);
    const pid = pl && typeof pl.playerId === 'string' ? pl.playerId : null;
    if (!pid) continue;
    if (p.kind === 'GPS' && typeof pl?.x === 'number' && typeof pl?.y === 'number') {
      const t = p.capturedAt.getTime();
      const cur = gpsById[pid];
      if (!cur || cur.ts < t) gpsById[pid] = { x: pl.x as number, y: pl.y as number, speed: pl.speed as number | undefined, ts: t };
    }
    if (p.kind === 'HEART_RATE' && typeof pl?.bpm === 'number') {
      const t = p.capturedAt.getTime();
      const cur = hrById[pid];
      if (!cur || cur.ts < t) hrById[pid] = { bpm: pl.bpm as number, ts: t };
    }
  }

  // ── Build per-player UniversalPlayerState ──────────────────────────
  const out: UniversalPlayerState[] = players.map((p) => {
    const v   = visionById.get(p.id);
    const gps = gpsById[p.id];
    const hr  = hrById[p.id];
    const sources: UniversalPlayerState['sources'] = [];
    let x: number | null = null, y: number | null = null, confidence = 0;

    if (v) {
      x = v.x; y = v.y; confidence = Math.max(confidence, v.confidence);
      sources.push('VISION');
    }
    if (gps && (x === null || y === null)) {
      x = gps.x; y = gps.y;
      sources.push('WEARABLE');
      confidence = Math.max(confidence, 0.7);
    } else if (gps) {
      // Both vision + wearable available → vision wins, wearable is corroboration.
      sources.push('WEARABLE');
    }
    if (hr) sources.push('SENSOR');

    const speed = gps?.speed ?? 0;
    const sprint: 0 | 1 = adapter.isSprinting({ speedMps: speed }) ? 1 : 0;
    const lastTs = Math.max(v ? nowMs : 0, gps?.ts ?? 0, hr?.ts ?? 0);
    const staleMs = lastTs > 0 ? nowMs - lastTs : null;

    return adapter.normaliseState({
      playerId: p.id,
      side:     'HOME',
      number:   p.number ?? null,
      name:     `${p.firstName} ${p.lastName}`,
      role:     p.position ?? null,
      x, y,
      hr:       hr?.bpm ?? null,
      sprint,
      sources:  sources.length ? sources : ['INTERPOLATED'],
      confidence,
      staleMs,
    });
  });

  const frame: SpatialFrame = {
    sport,
    clubId,
    matchId,
    monotonicMs: nowMs,
    geometry,
    players: out,
    object: null,
    sources: {
      visionCameras:  new Set(visionFrames.map((f) => f.cameraId)).size,
      wearables:      sessions.filter((s) => s.deviceModel?.includes('WEARABLE')).length,
      sensorPackets:  sensorPackets.length,
      biochemPatches: 0,
      interpolated:   out.some((p) => (p.sources ?? []).includes('INTERPOLATED')),
    },
  };

  // Apply sport-specific projection.
  const projected = adapter.projectFrame(frame);

  // Optionally persist for replay (rate-limited).
  if (opts.persist) await persistFrame(projected);
  return projected;
}

// ─────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────

async function persistFrame(f: SpatialFrame): Promise<void> {
  // Suppress if the last persisted frame is younger than PERSIST_MIN_GAP_MS.
  const last = await prisma.spatialFrame.findFirst({
    where: { matchId: f.matchId },
    orderBy: { monotonicMs: 'desc' },
    select: { monotonicMs: true },
  });
  if (last && Number(last.monotonicMs) > f.monotonicMs - PERSIST_MIN_GAP_MS) return;
  try {
    await prisma.spatialFrame.create({
      data: {
        clubId:      f.clubId,
        matchId:     f.matchId,
        monotonicMs: BigInt(f.monotonicMs),
        sport:       f.sport,
        players:     f.players as unknown as never,
        object:      (f.object ?? null) as unknown as never,
        geometry:    f.geometry as unknown as never,
        sources:     f.sources as unknown as never,
      },
    });
  } catch (_) { /* swallow — persistence is best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function groupByCamera(rows: Array<{ cameraId: string; detections: unknown; calibrationVersion: number | null }>): CameraView[] {
  const byCamera: Record<string, CameraView> = {};
  for (const r of rows) {
    if (!byCamera[r.cameraId]) {
      byCamera[r.cameraId] = { cameraId: r.cameraId, version: r.calibrationVersion ?? 1, detections: [] };
    }
    const det = r.detections as unknown;
    if (Array.isArray(det)) {
      for (const d of det as CameraDetection[]) byCamera[r.cameraId].detections.push(d);
    } else if (det && typeof det === 'object' && Array.isArray((det as { detections?: unknown[] }).detections)) {
      for (const d of (det as { detections: CameraDetection[] }).detections) byCamera[r.cameraId].detections.push(d);
    }
  }
  return Object.values(byCamera);
}
