// Familista — Vision Intelligence Engine
// File location: src/types/vision.types.ts
//
// Strict types for the JSON payloads on AnalyticsResult, LiveEvent, Clip and
// the inference adapter contract. Types are enforced application-side; the DB
// stays schemaless on payloads.

import type {
  VideoAsset,
  VideoIngestJob,
  VisionAnalysisRun,
  PlayerTrack,
  BallTrack,
  MatchEvent,
  AnalyticsResult,
  AnalyticsKind,
  FusedPlayerSample,
  FusionVerdict,
  Clip,
  ClipPurpose,
  ClipStatus,
  LiveMatchStream,
  LiveStreamStatus,
  LiveEvent,
  ScoutingReport,
  ScoutingKind,
  VisionEventType,
  TeamSide,
  IngestStage,
  IngestStatus,
  VisionAuditCategory,
  VisionAuditResult,
  PlatformRole,
} from '@prisma/client';

// ─── Access scope ────────────────────────────────────────────────────────────

export type VisionActorRole =
  | 'CLUB_ADMIN'
  | 'HEAD_COACH'
  | 'ASSISTANT_COACH'
  | 'ANALYST'
  | 'MEDICAL_STAFF'
  | 'SCOUT'
  | 'PLATFORM_ADMIN'
  | 'SYSTEM';

export type VisionAccessScope = {
  isPlatformAdmin: boolean;
  platformRole: PlatformRole | null;
  userId: string;
  clubId: string | null;
  userRole: VisionActorRole | null;
};

export type VisionActor = {
  userId: string;
  scope: VisionAccessScope;
  ipAddress: string | null;
  userAgent: string | null;
};

// ─── Pitch coordinates (0-100 normalised) ────────────────────────────────────

export type PitchPoint = { x: number; y: number };

// ─── Analytics payload contracts (per AnalyticsKind) ────────────────────────

export type HeatmapPayload = {
  zonesX: number;
  zonesY: number;
  cells: number[][];      // [zonesY][zonesX] occupancy seconds
  totalSeconds: number;
  attackingDirection?: 'LEFT_TO_RIGHT' | 'RIGHT_TO_LEFT';
};

export type PassingNetworkNode = {
  playerId: string | null;
  jerseyNumber: number | null;
  avgPos: PitchPoint;
  totalPasses: number;
  position: string | null;
};

export type PassingNetworkEdge = {
  from: string;           // playerId or `#{jersey}`
  to: string;
  count: number;
  avgLength: number;
  successRate: number;    // 0-1
};

export type PassingNetworkPayload = {
  teamSide: TeamSide;
  nodes: PassingNetworkNode[];
  edges: PassingNetworkEdge[];
  totalPasses: number;
  passAccuracy: number;
};

export type FormationSnapshotPayload = {
  teamSide: TeamSide;
  formation: string;      // '4-3-3' | '4-4-2' | '5-3-2' | ...
  windowStartMs: number;
  windowEndMs: number;
  rows: number[];         // e.g. [4, 3, 3]
  averagePositions: Array<{ playerId: string | null; jerseyNumber: number | null; pos: PitchPoint }>;
};

export type PressingEventPayload = {
  triggeredAtMs: number;
  durationMs: number;
  defendersInvolved: string[];     // player IDs
  attackerInvolved: string | null;
  pitchOrigin: PitchPoint;
  pressureRadius: number;
  outcome: 'TURNOVER_WON' | 'RELEASE' | 'FOUL' | 'BALL_OUT' | 'NO_EFFECT';
};

export type PossessionBlockPayload = {
  windowStartMs: number;
  windowEndMs: number;
  homeSeconds: number;
  awaySeconds: number;
  contestedSeconds: number;
  homePassCount: number;
  awayPassCount: number;
};

export type ShapeCompactnessPayload = {
  teamSide: TeamSide;
  avgPairwiseDistance: number;
  defensiveLineHeight: number;
  attackingLineHeight: number;
  width: number;
  length: number;
};

export type SprintProfilePayload = {
  playerId: string | null;
  sprintCount: number;
  totalSprintDistance: number;
  maxSprintSpeedKmh: number;
  avgAccelerationMs2: number;
  avgDecelerationMs2: number;
  recoveryTimeSec: number | null;
};

export type TechnicalExecutionPayload = {
  playerId: string | null;
  metric: 'PASSING' | 'SHOOTING' | 'DRIBBLING' | 'TACKLING' | 'AERIAL';
  attempts: number;
  successful: number;
  successRate: number;
  avgConfidence: number;
};

export type RepetitionQualityPayload = {
  playerId: string | null;
  drillKind: string;
  reps: number;
  qualityScore: number;          // 0-100
  consistency: number;           // 0-1
  fatigueDriftPct: number | null;
};

export type OffBallMovementPayload = {
  playerId: string | null;
  distanceOffBall: number;
  thirdManRuns: number;
  pressureReleases: number;
  spaceCreatedSqM: number | null;
};

export type AnalyticsPayloadFor<K extends AnalyticsKind> =
  K extends 'HEATMAP' ? HeatmapPayload :
  K extends 'PASSING_NETWORK' ? PassingNetworkPayload :
  K extends 'FORMATION_SNAPSHOT' ? FormationSnapshotPayload :
  K extends 'PRESSING_EVENT' ? PressingEventPayload :
  K extends 'POSSESSION_BLOCK' ? PossessionBlockPayload :
  K extends 'SHAPE_COMPACTNESS' ? ShapeCompactnessPayload :
  K extends 'SPRINT_PROFILE' ? SprintProfilePayload :
  K extends 'TECHNICAL_EXECUTION' ? TechnicalExecutionPayload :
  K extends 'REPETITION_QUALITY' ? RepetitionQualityPayload :
  K extends 'OFF_BALL_MOVEMENT' ? OffBallMovementPayload :
  Record<string, unknown>;

// ─── Inference adapter contract ──────────────────────────────────────────────

export type InferenceSubmission = {
  videoAssetId: string;
  videoUrl: string;
  matchId?: string | null;
  trainingSessionId?: string | null;
  fps?: number | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
};

export type InferenceSubmissionResult = {
  externalJobId: string;
  estimatedDurationSec: number | null;
};

export type InferenceStatus = {
  stage: IngestStage;
  status: IngestStatus;
  progress: number;
  error: string | null;
};

export type InferenceTrack = {
  playerId: string | null;
  jerseyNumber: number | null;
  teamSide: TeamSide;
  startMs: number;
  endMs: number;
  avgX: number;
  avgY: number;
  topSpeedKmh: number | null;
  avgSpeedKmh: number | null;
  totalDistanceM: number | null;
  sprintCount: number | null;
  accelerations: number | null;
  decelerations: number | null;
  pathUrl: string | null;
  confidence: number;
};

export type InferenceBallTrack = {
  startMs: number;
  endMs: number;
  pathUrl: string | null;
  avgSpeedKmh: number | null;
  topSpeedKmh: number | null;
  inPlayMs: number | null;
  confidence: number;
};

export type InferenceEvent = {
  type: VisionEventType;
  occurredAtMs: number;
  frame: number | null;
  durationMs: number | null;
  primaryPlayerId: string | null;
  secondaryPlayerId: string | null;
  teamSide: TeamSide;
  pitchX: number | null;
  pitchY: number | null;
  confidence: number;
  payload: Record<string, unknown> | null;
};

export type InferenceResults = {
  modelProvider: string;
  modelVersion: string;
  durationMs: number;
  framesProcessed: number;
  framesTotal: number | null;
  overallConfidence: number;
  playerTracks: InferenceTrack[];
  ballTracks: InferenceBallTrack[];
  events: InferenceEvent[];
};

// ─── Clip render adapter contract ────────────────────────────────────────────

export type ClipRenderRequest = {
  videoUrl: string;
  startMs: number;
  endMs: number;
  format?: 'MP4' | 'WEBM';
  thumbnail?: boolean;
  watermarkText?: string | null;
};

export type ClipRenderSubmission = {
  externalRenderId: string;
  estimatedDurationSec: number | null;
};

export type ClipRenderResult = {
  status: ClipStatus;
  url: string | null;
  thumbnailUrl: string | null;
  durationMs: number | null;
  bytes: number | null;
  error: string | null;
};

// ─── Re-exports ──────────────────────────────────────────────────────────────

export type {
  VideoAsset,
  VideoIngestJob,
  VisionAnalysisRun,
  PlayerTrack,
  BallTrack,
  MatchEvent,
  AnalyticsResult,
  AnalyticsKind,
  FusedPlayerSample,
  FusionVerdict,
  Clip,
  ClipPurpose,
  ClipStatus,
  LiveMatchStream,
  LiveStreamStatus,
  LiveEvent,
  ScoutingReport,
  ScoutingKind,
  VisionEventType,
  TeamSide,
  IngestStage,
  IngestStatus,
  VisionAuditCategory,
  VisionAuditResult,
};
