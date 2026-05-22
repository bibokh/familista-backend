// Familista — Realtime ingest bridge (Phase D-IP)
// ─────────────────────────────────────────────────────────────────────────
// Single funnel: every persisted SensorPacket → MatchChannel fan-out.
//
// Why a separate file: we keep the persistence path (device-session.service)
// free of realtime concerns, and we keep the realtime channel free of
// device-session details. This file is the only thing that knows both.
//
// Cost model: this is fired AFTER the DB write completes. It is best-effort
// — a thrown exception is logged but never re-raised, so a misbehaving
// subscriber cannot break ingest. Multiple subscribers are fanned out
// in MatchChannel.publish() which already swallows per-subscriber errors.

import { publish } from '../realtime/match-channel';
import type { SensorPacketKind } from '@prisma/client';
import { logger } from '../utils/logger';

interface RealtimeContext {
  clubId:   string;
  matchId?: string | null;
}

/** Single packet → channel. */
export function emitSensorPacket(
  ctx: RealtimeContext,
  packet: {
    id?:        string;
    kind:       SensorPacketKind;
    capturedAt: Date | string;
    payload:    unknown;
  },
): void {
  if (!ctx.matchId) return;       // sensor packets without a match: nothing to broadcast yet
  try {
    publish({
      kind:    'AI_INSIGHT',      // reuse the existing channel envelope kind for "out-of-band telemetry"
      matchId: ctx.matchId,
      clubId:  ctx.clubId,
      payload: {
        what:       'SENSOR_PACKET',
        sensorKind: packet.kind,
        capturedAt: packet.capturedAt instanceof Date ? packet.capturedAt.toISOString() : packet.capturedAt,
        // Trim the payload before broadcasting — we only need keys clients
        // care about (no raw IMU bursts).
        summary:    summariseSensorPayload(packet.kind, packet.payload),
      },
    });
  } catch (err) {
    logger.warn('[fusion-rt] emit failed', { err: (err as Error)?.message });
  }
}

/** Batched packets → one summary event (avoids fan-out storms). */
export function emitSensorBatch(
  ctx: RealtimeContext,
  packets: Array<{ kind: SensorPacketKind; capturedAt: Date | string; payload: unknown }>,
): void {
  if (!ctx.matchId || packets.length === 0) return;
  try {
    const counts: Record<string, number> = {};
    for (const p of packets) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
    publish({
      kind:    'AI_INSIGHT',
      matchId: ctx.matchId,
      clubId:  ctx.clubId,
      payload: {
        what:       'SENSOR_BATCH',
        n:          packets.length,
        counts,
        firstAt:    packets[0].capturedAt instanceof Date ? packets[0].capturedAt.toISOString() : packets[0].capturedAt,
        lastAt:     packets[packets.length - 1].capturedAt instanceof Date
                      ? (packets[packets.length - 1].capturedAt as Date).toISOString()
                      : packets[packets.length - 1].capturedAt,
      },
    });
  } catch (err) {
    logger.warn('[fusion-rt] batch emit failed', { err: (err as Error)?.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Per-kind summaries — keep the WS frame TINY so we can run at 100 Hz IMU.
// Anything that wants raw values polls /api/v1/matches/:id/fusion.
// ─────────────────────────────────────────────────────────────────────────

type AnyPayload = Record<string, unknown>;

function summariseSensorPayload(kind: SensorPacketKind, payload: unknown): AnyPayload {
  const p = (payload || {}) as AnyPayload;
  switch (kind) {
    case 'GPS':
      return { speed: p.speed, x: p.x, y: p.y, playerId: p.playerId };
    case 'IMU':
      return { aMag: scalarMag(p.ax, p.ay, p.az), gMag: scalarMag(p.gx, p.gy, p.gz), playerId: p.playerId };
    case 'ECG':
    case 'HEART_RATE':
      return { bpm: p.bpm, playerId: p.playerId };
    case 'HEALTH_BUNDLE':
      return { keys: Object.keys(p).slice(0, 6), playerId: p.playerId };
    case 'EVENT':
    case 'DIAGNOSTIC':
    case 'POWER':
    case 'TURF_NODE':
      return { keys: Object.keys(p).slice(0, 6) };
    case 'VISION_FRAME':
      return { frameKb: typeof p.size === 'number' ? Math.round((p.size as number) / 1024) : undefined };
    default:
      return {};
  }
}

function scalarMag(x: unknown, y: unknown, z: unknown): number | undefined {
  const a = num(x), b = num(y), c = num(z);
  if (a === null || b === null || c === null) return undefined;
  return Number(Math.sqrt(a * a + b * b + c * c).toFixed(3));
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
