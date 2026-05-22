// Familista — Neuromorphic Vision contracts (Phase K)
// ─────────────────────────────────────────────────────────────────────────
// These TS types are the SHAPE of payloads flowing between:
//   - Edge AI vision runtimes (off-Render)
//   - The /api/v1/neuro/* surface (Render)
//   - Cognitive spatial engine (Phase G) — downstream
//
// We intentionally keep individual VisionEvent OUT of the DB. A single
// VisionEventBatch carries thousands of events as a JSON tuple array.
// Persisting one row per event would be unsafe write amplification.

import type { CameraKind, VisionSubjectKind } from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────
// Event camera primitives
// ─────────────────────────────────────────────────────────────────────────

/**
 * Single neuromorphic event. Tuple form for compactness:
 *   [tMicros, x, y, polarity, extra?]
 *
 * - tMicros : camera-local microseconds since stream open
 * - x, y    : pixel coordinates
 * - polarity: 0 = OFF (luminance drop), 1 = ON (luminance rise)
 * - extra   : optional sub-roi tag, depth estimate, etc.
 */
export type VisionEvent = [
  tMicros: number,
  x:       number,
  y:       number,
  polarity: 0 | 1,
  extra?:  Record<string, unknown>,
];

export interface VisionEventBatchPayload {
  /** Pre-aggregation window (μs) the edge node used. */
  windowUs: number;
  events:   VisionEvent[];
  /** Optional ROI bounds, helps cloud reconstruction. */
  roi?:     { x: number; y: number; w: number; h: number };
}

/** Envelope POSTed by an edge runtime to /neuro/streams/:id/event-batch. */
export interface IngestEventBatchEnvelope {
  /** Camera-local microseconds at the FIRST event of the batch. */
  cameraTsUs:   number;
  kind?:        'RAW' | 'AGGREGATED' | 'DOWNSAMPLED';
  payload:      VisionEventBatchPayload;
  /** HMAC-SHA256(camera.hmacSecret, cameraTsUs|nonce|sha256(payload-json)) base64. */
  sigB64:       string;
  /** Random per-batch nonce. */
  nonce:        string;
  /** Optional matchId override; otherwise inherits from the stream. */
  matchId?:     string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Multi-camera observation contracts
// ─────────────────────────────────────────────────────────────────────────

export interface CameraDetectionWorld {
  cameraId:   string;
  /** Pitch metres, post-calibration. */
  x: number; y: number; z?: number;
  confidence: number;
}

export interface MultiCameraSubjectObservation {
  monotonicMs: number;
  subjectKind: VisionSubjectKind;
  subjectId?:  string;
  detections:  CameraDetectionWorld[];
  /** Computed by the triangulation pipeline. */
  triangulated?: {
    x: number; y: number; z?: number;
    confidence: number;
    votes:      number;
    residualMeanM?: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Visual tactical signal contracts (input shape; storage is per-detector)
// ─────────────────────────────────────────────────────────────────────────

export interface PressingSignal {
  pressureMass:   number;
  synchronyIndex: number;
  contributingPlayers: string[];
}

export interface FormationSignal {
  formation:    string;          // "4-3-3" | "5-1" | …
  spots:        Array<{ role: string; x: number; y: number }>;
  similarity:   number;          // 0..1
}

export interface DefensiveLineSignal {
  lineX:          number;
  spreadY:        number;
  stabilityIndex: number;
}

export interface OverloadSignal {
  zoneX:     number;
  zoneY:     number;
  homeCount: number;
  awayCount: number;
  delta:     number;
}

export interface TransitionSignal {
  fromZone:   { x: number; y: number };
  toZone:     { x: number; y: number };
  sharpness:  number;          // 0..1
}

export interface CounterattackSignal {
  startMs:    number;
  endMs:      number;
  speedMps:   number;
}

// ─────────────────────────────────────────────────────────────────────────
// Edge AI vision runtime contracts
// ─────────────────────────────────────────────────────────────────────────

export interface EdgeInferencePacket {
  monotonicMs: number;
  kind:        'DETECT' | 'POSE' | 'BALL' | 'TACTICAL' | string;
  payload:     unknown;
  confidence?: number;
  latencyMs?:  number;
  modelVersionId?: string;
  sigB64?:     string;
  nonce?:      string;
}

export interface EdgeVisionHeartbeat {
  score:          number;
  latencyP95Ms?:  number;
  jobsPerMin?:    number;
  failuresPerMin?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Biomechanical packet — biochem patch payload
// ─────────────────────────────────────────────────────────────────────────

export interface BiomechanicalPacketPayload {
  /** Patch-local clock (ms). */
  deviceTsMs:   number;
  lactateMmol?: number;
  glucoseMg?:   number;
  hydrationPct?: number;
  cortisolProxy?: number;
  /** Any extra raw fields. */
  extra?:       Record<string, unknown>;
}

export interface IngestBiomechEnvelope {
  payload:    BiomechanicalPacketPayload;
  playerId?:  string | null;
  matchId?:   string | null;
  sigB64?:    string;
  nonce?:     string;
}

// Re-exports so callers don't need to import Prisma directly.
export type { CameraKind, VisionSubjectKind };
