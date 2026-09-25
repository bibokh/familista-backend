// FAMILISTA VISION — what a session IS, once the platform holds it
// ─────────────────────────────────────────────────────────────────────────────
// THE NORMALISER'S ONE JOB, AND THE ONE THING IT MAY NOT DO
//
// It reads what the validated engine wrote and shapes it for the platform. It
// may drop fields the platform does not use. It may rename. It may index.
//
// It may NOT decide anything the engine declined to decide.
//
// If the engine said calibration was NONE, the normaliser does not compute a
// pitch coordinate from a nearby frame. If the engine marked a ball position
// PROPAGATED, the normaliser does not report it as observed. If a role came
// back UNKNOWN, UNKNOWN is what the platform stores and UNKNOWN is what the
// screen says. Every one of those rules exists because the alternative — a
// presentation layer quietly improving on its evidence — is how a system ends
// up confidently wrong, and this engine spent five validation phases learning
// not to be.
//
// WHY THE ORIGINAL ARTEFACT IS KEPT AND NEVER REWRITTEN
//
// A better model next year will produce different derived results from the same
// video. When it does, the platform must be able to show both and say which
// came from where. That is only possible if the original evidence is still
// exactly as the engine wrote it, so the normaliser copies forward and never
// edits, and the Data Vault records point back at an artefact that has not
// moved.

/** The four origins, exactly as the engine uses them. Never widened here. */
export type EvidenceOrigin = 'MEASURED' | 'PROPAGATED' | 'SYNTHETIC' | 'UNKNOWN';

/** The engine's calibration chain, unchanged. */
export type CalibrationChain = 'measured' | 'propagated' | 'none';

/** The engine's confidence bands, unchanged. */
export type ConfidenceBand = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export type BallState = 'OBSERVED' | 'PROPAGATED' | 'UNKNOWN' | 'NOT_AVAILABLE';

export interface VisionModelRef {
  modelId: string;
  registered: boolean;
  name?: string;
  version?: string;
  task?: string;
  framework?: string;
  weights?: string | null;
  checksumSha256?: string | null;
  licenceSoftware?: string | null;
  licenceWeights?: string | null;
  licenceDataset?: string | null;
  commercialUse?: string;
  licenceVerification?: string;
}

export interface VisionProviderRef {
  role: string;
  provider: string;
  modelIds: string[];
  settings: Record<string, unknown>;
  fusesDetectionAndTracking?: boolean;
}

export interface VisionSourceRef {
  sourceId: string;
  /** VIDEO_FILE today. The vocabulary in `source-types.ts` covers the rest. */
  sourceType: string;
  displayName: string;
  /** Media reference, never a filesystem path that leaves the server. */
  mediaRef: string | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  rotationDegrees: number | null;
  qualityBand: string | null;
  qualityScore: number | null;
}

export interface VisionTrackObservation {
  frameNumber: number;
  timestamp: number;
  identity: string;
  trackId: number;
  teamId: string | null;
  role: string;
  classificationConfidence: number | null;
  detectionConfidence: number | null;
  box: { x1: number; y1: number; x2: number; y2: number };
  imageX: number;
  imageY: number;
  /** Present ONLY when the engine published one. Null is a real answer. */
  pitchXM: number | null;
  pitchYM: number | null;
  calibrationChain: CalibrationChain;
  calibrationConfidence: ConfidenceBand;
  calibrationErrorM: number | null;
  shotId: number | null;
}

export interface VisionBallSample {
  frameNumber: number;
  timestamp: number;
  state: BallState;
  imageX: number | null;
  imageY: number | null;
  pitchXM: number | null;
  pitchYM: number | null;
  trackingConfidence: number | null;
  detectionConfidence: number | null;
  /** Frames since the ball was last DIRECTLY observed. 0 on an observation. */
  framesSinceObservation: number | null;
  nearestPlayer: string | null;
  nearestDistanceM: number | null;
  nearestDistancePx: number | null;
  /**
   * The engine's own sentence about why this sample is in the state it is in.
   *
   * Carried because it is the difference between a reader believing a
   * propagated position and understanding it: "no detection for 1 frame(s);
   * position carried through camera motion" says more than the word PROPAGATED
   * can.
   */
  reason: string | null;
  origin: EvidenceOrigin;
}

export interface VisionCalibrationFrame {
  frameNumber: number;
  chain: CalibrationChain;
  confidence: ConfidenceBand;
  expectedErrorM: number | null;
  framesSinceAnchor: number | null;
  /** The engine's unitless quality score for this solution. */
  score: number | null;
  /**
   * The landmark sentence and the pixel residual, when the artefact carries
   * them. This engine schema records them on the calibration state and not on
   * the per-frame provenance, so they are usually null here — which is why the
   * screen draws an em dash rather than a zero. A later engine that publishes
   * them per frame needs no change on this side.
   */
  landmark: string | null;
  reprojectionErrorPx: number | null;
  isAnchor: boolean;
}

export interface VisionFootballEvent {
  eventId: string;
  type: string;
  state: string;
  frameNumber: number;
  timestamp: number;
  trackIds: string[];
  teamId: string | null;
  ballState: BallState | null;
  pitchXM: number | null;
  pitchYM: number | null;
  confidence: number | null;
  origin: EvidenceOrigin;
  reason: string | null;
  evidence: Record<string, unknown>;
}

export interface VisionRoleEvidence {
  identity: string;
  role: string;
  confidence: number | null;
  reason: string | null;
  observations: number | null;
}

/** What the session says about itself. Every figure measured, none assumed. */
export interface VisionSessionSummary {
  sessionId: string;
  sessionRef: string;
  clubId: string | null;
  teamId: string | null;
  matchId: string | null;
  deviceId: string;
  processingTarget: string;
  schema: string;
  pipelineVersion: string | null;
  generatedAt: string | null;
  importedAt: string;

  source: VisionSourceRef;
  providers: VisionProviderRef[];
  models: VisionModelRef[];

  framesProcessed: number;
  observationsTotal: number;
  identities: number;
  rawTrackIds: number;
  teamAssignmentRate: number | null;
  observationsWithPitchCoords: number;
  coordsOnPitchRate: number | null;

  calibrationCoverage: number | null;
  calibrationMeasuredFrames: number;
  calibrationPropagatedFrames: number;
  anchorsAccepted: number;
  anchorDisagreementMedianM: number | null;

  ballFrames: number;
  ballStates: Record<string, number>;
  ballObservedCoverage: number | null;
  calibratedBallFrames: number;

  eventCounts: Record<string, number>;
  confidenceBands: Record<string, number>;
  processingSeconds: number | null;
  processingFps: number | null;

  /** Guard outcomes, carried so a reader sees what was WITHHELD and why. */
  guards: Record<string, unknown>;
  /** Capabilities this session genuinely has, for the UI's empty states. */
  capabilities: VisionCapabilities;
}

/**
 * What this session can and cannot answer.
 *
 * Computed from the evidence, never from a wish. A screen asks this before it
 * draws, so an empty heatmap says INSUFFICIENT CALIBRATED TRACKING DATA with a
 * measured reason attached rather than rendering an apologetic blank box.
 */
export interface VisionCapabilities {
  tracking: boolean;
  teams: boolean;
  roles: boolean;
  ball: boolean;
  metricCoordinates: boolean;
  heatmaps: boolean;
  events: boolean;
  tactical: boolean;
  physicalMetrics: boolean;
  /** Why each false is false, keyed by capability. */
  reasons: Record<string, string>;
}

export interface VisionSession {
  summary: VisionSessionSummary;
  tracks: VisionTrackObservation[];
  ball: VisionBallSample[];
  calibration: VisionCalibrationFrame[];
  events: VisionFootballEvent[];
  roles: VisionRoleEvidence[];
}
