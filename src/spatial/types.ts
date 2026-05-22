// Familista — Universal Spatial + Multi-Sport contracts (Phase G)
// ─────────────────────────────────────────────────────────────────────────
// These are the SPORT-AGNOSTIC contracts that every sport adapter, every
// realtime engine, and every downstream consumer (frontend, big-data,
// AI agents) speaks. The football-specific FusionPacket (Phase D-IP) and
// TacticalState (Phase E) are *projections* of these types.
//
// Why a new universal layer (and not just generalising Phase E)?
//   - TacticalState has football-specific assumptions (HOME/AWAY, 105×68,
//     formation strings like "4-3-3").
//   - Phase G must scale to tennis (2 players, court), basketball (10,
//     half-court rotation), athletics (1..N runners, lane bias).
//   - We do NOT refactor Phase E — TacticalState keeps working unchanged.
//     SpatialFrame is the wider contract used by Phase G+.

import type { SportKind } from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────
// Geometry — sport-specific pitch / court / track
// ─────────────────────────────────────────────────────────────────────────

export interface TacticalGeometry {
  sport:       SportKind;
  /** Field width in metres (long axis). */
  widthM:      number;
  /** Field height in metres (short axis). */
  heightM:     number;
  /** Sport-specific zones (penalty box, 3-point arc, service box, …). */
  zones?:      Array<{
    id:     string;
    label:  string;
    /** Polygon in pitch coords (0..widthM × 0..heightM). */
    poly:   Array<[number, number]>;
    /** Which side the zone belongs to (relevant only for two-sided sports). */
    side?:  'HOME' | 'AWAY' | 'NEUTRAL';
  }>;
  /** Net / basket / goal line locations — sport-specific. */
  targets?:    Array<{ id: string; label: string; x: number; y: number }>;
  /** Whether the sport has a single ball / object that all players orient around. */
  hasSharedObject: boolean;
  /** Max players per side in regular play. */
  playersPerSide: number;
  /** True if the field flips at halftime (football, hockey). */
  sidesFlipAtHalf: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// UniversalPlayerState — single player snapshot, multi-sport
// ─────────────────────────────────────────────────────────────────────────

export interface UniversalPlayerState {
  playerId:   string;
  /** "HOME" | "AWAY" | numeric lane / serve side / etc. */
  side:       'HOME' | 'AWAY' | string;
  number?:    number | null;
  name?:      string | null;
  role?:      string | null;
  /** Position in pitch metres (0..geometry.widthM × 0..geometry.heightM). */
  x:          number | null;
  y:          number | null;
  /** Z is 0 for ground sports; non-zero for jumps, drone-tracked athletics. */
  z?:         number | null;
  /** Velocity (m/s). */
  vx?:        number | null;
  vy?:        number | null;
  vz?:        number | null;
  /** Heading degrees, 0=east, ccw. */
  heading?:   number | null;
  /** Heart-rate, accel magnitude, fatigue index — pulled from wearables. */
  hr?:        number | null;
  /** Sprint flag (1 if instantaneous speed > sport-specific threshold). */
  sprint?:    0 | 1;
  /** Sport-agnostic load index 0..1. */
  load?:      number | null;
  /** Categorical alert from rules engine. */
  alert?:     'OK' | 'CAUTION' | 'CRITICAL';
  /** Best-guess source(s) that contributed to this row. */
  sources?:   Array<'VISION' | 'WEARABLE' | 'SENSOR' | 'BIOCHEM' | 'INTERPOLATED'>;
  /** Per-sensor confidence in the spatial reading [0..1]. */
  confidence?: number;
  /** ms since last observation for this player. */
  staleMs?:   number | null;
}

// ─────────────────────────────────────────────────────────────────────────
// UniversalEventEnvelope — every state-changing event in any sport.
// This is the SAME shape we'll push to Kafka topics so downstream
// consumers don't need to know which sport produced the event.
// ─────────────────────────────────────────────────────────────────────────

export interface UniversalEventEnvelope<P = unknown> {
  /** Schema version — bump on breaking change. Consumers can pin. */
  v:        '1';
  /** Coarse type. Sport adapters annotate with finer detail in `payload`. */
  type:
    | 'PLAYER_SPATIAL'
    | 'OBJECT_SPATIAL'
    | 'EVENT'            // goal, point, foul, sub, …
    | 'TACTICAL_FRAME'
    | 'PREDICTION'
    | 'ANNOTATION'
    | 'CUSTOM';
  sport:    SportKind;
  clubId:   string;
  matchId?: string | null;
  /** Monotonic synchronised ms (global frame). */
  ts:       number;
  /** Sport-specific finer kind: "GOAL" | "ACE" | "FREE_THROW" | "FAULT" | … */
  kind:     string;
  payload:  P;
  /** Source signature — what produced this event. */
  source?:  string;
}

// ─────────────────────────────────────────────────────────────────────────
// SpatialFrame — full fused state at one instant
// ─────────────────────────────────────────────────────────────────────────

export interface SpatialFrame {
  sport:        SportKind;
  clubId:       string;
  matchId:      string;
  monotonicMs:  number;
  geometry:     TacticalGeometry;
  players:      UniversalPlayerState[];
  /** Single shared object (ball / puck / shuttle / discus, …). */
  object?:      {
    x:          number | null;
    y:          number | null;
    z?:         number | null;
    vx?:        number | null;
    vy?:        number | null;
    vz?:        number | null;
    confidence?: number;
  } | null;
  /** Diagnostics: which sources contributed and at what confidence. */
  sources: {
    visionCameras:    number;   // how many cameras emitted detections in this frame
    wearables:        number;
    sensorPackets:    number;
    biochemPatches:   number;
    /** True if engine had to fall back to interpolation. */
    interpolated:     boolean;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// CameraDetection — what an edge node ships to /vision/cameras/:id/frame
// ─────────────────────────────────────────────────────────────────────────

export interface CameraDetection {
  /** Track id — stable across frames from the same camera. */
  trackId:    string;
  /** Class label: "player" | "ball" | "ref" | "boundary" | … */
  class:      string;
  /** Bounding box in pixels OR normalised pitch coords if calibrated. */
  x:          number;
  y:          number;
  w?:         number;
  h?:         number;
  /** Optional 3D position in pitch metres (set by edge node if multi-camera). */
  worldX?:    number;
  worldY?:    number;
  worldZ?:    number;
  /** 0..1 inference confidence. */
  confidence: number;
  /** Optional cross-camera identity binding to a player UUID. */
  playerId?:  string | null;
}

/** Event-camera payload — same envelope but emits a stream of pixel events
 *  instead of bounding boxes. Edge nodes pre-aggregate to a "frame" of
 *  events per N ms window so the API doesn't drown. */
export interface EventCameraBatch {
  windowMs:   number;
  /** [t_us, x, y, polarity], pre-aggregated to ROI-level summaries. */
  events:     Array<[number, number, number, 0 | 1]>;
}
