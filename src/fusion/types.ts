// Familista — Cognitive Sensor-to-Vision Spatial Fusion Protocol
// File: src/fusion/types.ts
//
// Type-only foundation for the fusion layer. Every heterogeneous sensor
// stream that enters Familista is normalised into one of the packet shapes
// below before any analytics layer touches it. The unified shape is what
// makes the fusion patentable — every packet carries:
//
//   - a GlobalTimestampMs   (monotonic, backend-aligned)
//   - a deviceSessionId     (tenant inheritance — never declared by device)
//   - a kind                (discriminator)
//   - an optional sigB64    (HMAC over payload; PCB integrity check)
//
// No runtime code lives in this file — only types + enum constants. Keep
// it dependency-free so it can also be consumed by edge SDKs (TS target
// ESP-IDF or React Native).

// ─────────────────────────────────────────────────────────────────────────
// Global time
// ─────────────────────────────────────────────────────────────────────────

/** Monotonic backend-aligned timestamp, milliseconds since unix epoch. */
export type GlobalTimestampMs = number;

/** Raw device timestamp before backend alignment. */
export interface DeviceTimestamp {
  /** Device-local monotonic counter (microseconds). */
  deviceUs:    number;
  /** Server's receive time (ms since epoch). */
  serverRxMs:  GlobalTimestampMs;
  /** Per-session offset (added to deviceUs/1000 to align). */
  offsetMs:    number;
  /** One-way drift estimate per second of session age. */
  driftPpm?:   number;
}

// ─────────────────────────────────────────────────────────────────────────
// Packet kinds (mirrors SensorPacketKind in Prisma; superset for vision)
// ─────────────────────────────────────────────────────────────────────────

export type FusionPacketKind =
  | 'GPS'
  | 'IMU'
  | 'ECG'
  | 'HEART_RATE'
  | 'HEALTH_BUNDLE'
  | 'EVENT'
  | 'VISION_FRAME'         // legacy CCTV frame
  | 'NEURO_VISION_EVENT'   // neuromorphic event-based vision: (x, y, polarity, t_us)
  | 'BIOCHEM_PATCH'        // epidermal patch (lactate, cortisol, glucose, hydration)
  | 'IBC'                  // Intra-Body Communication beacon (future)
  | 'TURF_NODE'            // smart-field node payload
  | 'POWER'
  | 'DIAGNOSTIC'
  | 'TACTICAL_EVENT'       // human-entered timeline event lifted into the fusion stream
  | 'POSE_KEYPOINTS'       // 3D skeleton pose estimate at a given ts
  | 'BALL';                // ball position/velocity from camera or smart ball

// ─────────────────────────────────────────────────────────────────────────
// FusionPacket — the universal envelope
// ─────────────────────────────────────────────────────────────────────────

export interface FusionPacketBase<Kind extends FusionPacketKind, Payload> {
  kind:             Kind;
  ts:               GlobalTimestampMs;
  deviceSessionId:  string;
  clubId:           string;
  teamId?:          string | null;
  matchId?:         string | null;
  trainingId?:      string | null;
  playerId?:        string | null;          // present if the packet pertains to a single player
  /** Confidence in this packet's measurement, 0..1. */
  confidence?:      number;
  /** HMAC-SHA256 base64 over `kind|ts|payload`, signed with sessionKey. */
  sigB64?:          string;
  payload:          Payload;
}

// ── Per-kind payload shapes ─────────────────────────────────────────────

export interface GpsPayload {
  /** WGS84 latitude. */
  lat:     number;
  lon:     number;
  alt?:    number;
  /** Speed in m/s. */
  speed:   number;
  heading?: number;       // degrees
  hdop?:   number;
  /** Field-local x,y in metres (post-transform). Optional — computed downstream. */
  x?:      number;
  y?:      number;
}
export interface ImuPayload {
  /** Acceleration vector, m/s². Gravity removed. */
  ax: number; ay: number; az: number;
  /** Angular velocity, rad/s. */
  gx: number; gy: number; gz: number;
}
export interface EcgPayload {
  bpm:      number;
  rrIntervalMs?: number;          // beat-to-beat
  hrv?:     number;               // root mean square of successive differences
  qualityB?: number;              // 0..1
}
export interface BiochemPayload {
  lactateMmol?:   number;
  cortisolNgMl?:  number;
  glucoseMgDl?:   number;
  hydrationPct?:  number;
  patchTemperature?: number;
  /** Quality 0..1 — patches degrade after ~24h. */
  q?:             number;
}
export interface PosePayload {
  /** 17-keypoint COCO-style 3D pose, normalised metres relative to pelvis. */
  joints: Array<{ name: string; x: number; y: number; z: number; conf: number }>;
}
export interface NeuroVisionEventPayload {
  /** Pixel column. */
  x:       number;
  /** Pixel row. */
  y:       number;
  /** Event polarity: +1 brightness up, -1 brightness down. */
  p:       1 | -1;
  /** Camera-local microsecond timestamp. */
  tUs:     number;
}
export interface BallPayload {
  x:       number;
  y:       number;
  z?:      number;
  vx?:     number;
  vy?:     number;
  vz?:     number;
}
export interface TacticalEventPayload {
  /** Mirrors MatchTimelineKind values. */
  kind:    string;
  side:    'HOME' | 'AWAY';
  pitchX?: number;
  pitchY?: number;
  primaryPlayerId?:   string;
  secondaryPlayerId?: string;
  notes?:  string;
}

export type FusionPacket =
  | FusionPacketBase<'GPS',                GpsPayload>
  | FusionPacketBase<'IMU',                ImuPayload>
  | FusionPacketBase<'ECG',                EcgPayload>
  | FusionPacketBase<'HEART_RATE',         { bpm: number }>
  | FusionPacketBase<'BIOCHEM_PATCH',      BiochemPayload>
  | FusionPacketBase<'NEURO_VISION_EVENT', NeuroVisionEventPayload>
  | FusionPacketBase<'POSE_KEYPOINTS',     PosePayload>
  | FusionPacketBase<'BALL',               BallPayload>
  | FusionPacketBase<'TACTICAL_EVENT',     TacticalEventPayload>
  | FusionPacketBase<'EVENT',              Record<string, unknown>>
  | FusionPacketBase<'TURF_NODE',          Record<string, unknown>>
  | FusionPacketBase<'POWER',              Record<string, unknown>>
  | FusionPacketBase<'DIAGNOSTIC',         Record<string, unknown>>
  | FusionPacketBase<'VISION_FRAME',       Record<string, unknown>>
  | FusionPacketBase<'IBC',                Record<string, unknown>>
  | FusionPacketBase<'HEALTH_BUNDLE',      Record<string, unknown>>;

// ─────────────────────────────────────────────────────────────────────────
// Derived state
// ─────────────────────────────────────────────────────────────────────────

/** Snapshot of one player at one instant — the spatial primitive. */
export interface PlayerSpatialState {
  playerId:   string;
  ts:         GlobalTimestampMs;
  /** Pitch-local coordinates, metres. (0,0) = bottom-left corner of our half. */
  x:          number;
  y:          number;
  z?:         number;
  vx?:        number;
  vy?:        number;
  /** Sprint indicator, 0 or 1. */
  sprint?:    0 | 1;
  hr?:        number;
  /** Cumulative distance (m) since match start. */
  distM?:     number;
  /** Z-score normalised acceleration load over last 60 s. */
  aLoadZ?:    number;
  /** Source mix for transparency. */
  source:     'GPS' | 'POSE' | 'GPS+POSE' | 'IMU' | 'FUSED';
  /** Confidence in this state estimate, 0..1. */
  confidence: number;
}

/** Output of the biomechanical load calculator. */
export interface BiomechanicalLoadIndex {
  playerId:    string;
  windowMs:    number;          // window over which BLI was integrated
  components:  {
    accelLoad:    number;       // z-scored
    sprintLoad:   number;
    hrStress:     number;
    jointStrain:  number;
    mechanicalWork: number;
  };
  /** Final BLI value, typically [-3, +5]. */
  value:       number;
  computedAt:  GlobalTimestampMs;
}

/** Output of the tactical attrition calculator. */
export interface TacticalAttritionIndex {
  playerId:    string;
  windowMs:    number;
  components:  {
    bliZ:                 number;
    biochemFatigueDelta:  number;
    tacticalDelaySec:     number;
    positionalDeviationM: number;
    recoveryLagSec:       number;
    sprintDegradation:    number;
    injuryRiskP:          number;
  };
  /** Final TAI value, typically [0, 1]. */
  value:       number;
  computedAt:  GlobalTimestampMs;
}

/** One row in the fusion frame — one player at the latest instant. */
export interface FusionFrameRow {
  player:   { id: string; firstName: string; lastName: string; number: number; position: string };
  state:    PlayerSpatialState | null;
  bli:      BiomechanicalLoadIndex | null;
  tai:      TacticalAttritionIndex | null;
}

/** Aggregate output for a match. */
export interface FusionFrame {
  matchId:        string;
  clubId:         string;
  generatedAt:    GlobalTimestampMs;
  /** Backend-aligned latest timestamp across all sensors for this match. */
  fusedNowMs:     GlobalTimestampMs | null;
  /** Number of raw packets considered per kind. */
  packetCounts:   Record<string, number>;
  /** Per-player rolled-up state. */
  rows:           FusionFrameRow[];
  /** Match-wide aggregates (pressing index, line height, etc.) — Phase E. */
  teamMetrics?:   Record<string, number>;
  /** Diagnostics — clock skew, dropped packets, etc. */
  diagnostics?:   {
    sessions: Array<{ id: string; deviceModel: string; offsetMs: number; packets: number }>;
    notes:    string[];
  };
}
