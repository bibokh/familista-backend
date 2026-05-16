// Familista — Vision Intelligence Engine
// File location: src/utils/vision.validators.ts
//
// Zod schemas for all vision endpoints. Strict mode — unknown keys rejected.

import { z } from 'zod';

const cuidOrUuid = z.string().min(8).max(64);
const iso8601 = z.string().datetime();

export const VIDEO_SOURCES = ['UPLOAD', 'STREAM_URL', 'HLS', 'RTMP', 'EXTERNAL_PROVIDER'] as const;
export const VIDEO_FORMATS = ['MP4', 'MKV', 'MOV', 'HLS', 'RTMP', 'WEBM'] as const;
export const INGEST_STAGES = ['UPLOADED', 'DEMUXED', 'INFERRED', 'TRACKED', 'EVENTS_DETECTED', 'ANALYTICS_COMPUTED', 'FUSED', 'COMPLETED', 'FAILED'] as const;
export const INGEST_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export const TEAM_SIDES = ['HOME', 'AWAY', 'UNKNOWN'] as const;
export const VISION_EVENT_TYPES = [
  'PASS', 'SHOT', 'SAVE', 'TACKLE', 'INTERCEPTION', 'CLEARANCE', 'DRIBBLE',
  'FOUL', 'OFFSIDE', 'YELLOW_CARD', 'RED_CARD', 'GOAL',
  'THROW_IN', 'CORNER', 'FREE_KICK', 'PENALTY', 'SUBSTITUTION',
  'POSSESSION_CHANGE', 'PRESSING_TRIGGER', 'COUNTER_ATTACK', 'SET_PIECE',
  'HEADER', 'CROSS', 'SPRINT', 'ACCELERATION', 'DECELERATION', 'OTHER',
] as const;
export const ANALYTICS_KINDS = [
  'HEATMAP', 'PASSING_NETWORK', 'FORMATION_SNAPSHOT', 'PRESSING_EVENT',
  'POSSESSION_BLOCK', 'ZONE_OCCUPATION', 'SHAPE_COMPACTNESS', 'DEFENSIVE_LINE',
  'TRANSITION_SPEED', 'BUILD_UP_PATTERN', 'SPRINT_PROFILE', 'TECHNICAL_EXECUTION',
  'REPETITION_QUALITY', 'OFF_BALL_MOVEMENT',
] as const;
export const CLIP_PURPOSES = ['HIGHLIGHT', 'COACH_REVIEW', 'PLAYER_FEEDBACK', 'OPPONENT_SCOUTING', 'TALENT_DETECTION', 'TACTICAL_REFERENCE', 'INCIDENT'] as const;
export const SCOUTING_KINDS = ['OPPONENT_BRIEF', 'TALENT_SCAN', 'RECRUITMENT_BRIEF', 'ACADEMY_PROSPECT', 'MATCH_REPORT'] as const;

// ─── Video assets ────────────────────────────────────────────────────────────

export const registerVideoSchema = z
  .object({
    source: z.enum(VIDEO_SOURCES),
    format: z.enum(VIDEO_FORMATS),
    url: z.string().url(),
    durationMs: z.number().int().min(0).optional().nullable(),
    fps: z.number().min(0).max(240).optional().nullable(),
    width: z.number().int().min(0).optional().nullable(),
    height: z.number().int().min(0).optional().nullable(),
    fileBytes: z.number().int().min(0).optional().nullable(),
    checksum: z.string().max(128).optional().nullable(),
    clubId: cuidOrUuid.optional().nullable(),
    matchId: cuidOrUuid.optional().nullable(),
    trainingSessionId: cuidOrUuid.optional().nullable(),
    title: z.string().max(200).optional().nullable(),
    description: z.string().max(5000).optional().nullable(),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const updateVideoSchema = registerVideoSchema.partial().strict();

// ─── Ingest ──────────────────────────────────────────────────────────────────

export const startIngestSchema = z
  .object({
    provider: z.string().min(1).max(80).optional(),
    notes: z.string().max(2000).optional().nullable(),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const transitionIngestSchema = z
  .object({
    stage: z.enum(INGEST_STAGES),
    status: z.enum(INGEST_STATUSES).optional(),
    progress: z.number().min(0).max(1).optional(),
    error: z.string().max(5000).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  })
  .strict();

// ─── Inference webhook payloads ──────────────────────────────────────────────

const inferenceTrackSchema = z
  .object({
    playerId: cuidOrUuid.optional().nullable(),
    jerseyNumber: z.number().int().min(0).max(99).optional().nullable(),
    teamSide: z.enum(TEAM_SIDES).default('UNKNOWN'),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    avgX: z.number().min(0).max(100),
    avgY: z.number().min(0).max(100),
    topSpeedKmh: z.number().min(0).max(60).optional().nullable(),
    avgSpeedKmh: z.number().min(0).max(60).optional().nullable(),
    totalDistanceM: z.number().min(0).optional().nullable(),
    sprintCount: z.number().int().min(0).optional().nullable(),
    accelerations: z.number().int().min(0).optional().nullable(),
    decelerations: z.number().int().min(0).optional().nullable(),
    pathUrl: z.string().url().optional().nullable(),
    confidence: z.number().min(0).max(1).default(1),
  })
  .strict();

const inferenceBallTrackSchema = z
  .object({
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    pathUrl: z.string().url().optional().nullable(),
    avgSpeedKmh: z.number().min(0).max(180).optional().nullable(),
    topSpeedKmh: z.number().min(0).max(180).optional().nullable(),
    inPlayMs: z.number().int().min(0).optional().nullable(),
    confidence: z.number().min(0).max(1).default(1),
  })
  .strict();

const inferenceEventSchema = z
  .object({
    type: z.enum(VISION_EVENT_TYPES),
    occurredAtMs: z.number().int().min(0),
    frame: z.number().int().min(0).optional().nullable(),
    durationMs: z.number().int().min(0).optional().nullable(),
    primaryPlayerId: cuidOrUuid.optional().nullable(),
    secondaryPlayerId: cuidOrUuid.optional().nullable(),
    teamSide: z.enum(TEAM_SIDES).default('UNKNOWN'),
    pitchX: z.number().min(0).max(100).optional().nullable(),
    pitchY: z.number().min(0).max(100).optional().nullable(),
    confidence: z.number().min(0).max(1).default(1),
    payload: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const inferenceResultsSchema = z
  .object({
    modelProvider: z.string().min(1).max(120),
    modelVersion: z.string().min(1).max(40),
    durationMs: z.number().int().min(0),
    framesProcessed: z.number().int().min(0),
    framesTotal: z.number().int().min(0).optional().nullable(),
    overallConfidence: z.number().min(0).max(1),
    playerTracks: z.array(inferenceTrackSchema).max(20000),
    ballTracks: z.array(inferenceBallTrackSchema).max(10000),
    events: z.array(inferenceEventSchema).max(50000),
  })
  .strict();

// ─── Event override ──────────────────────────────────────────────────────────

export const overrideEventSchema = z
  .object({
    type: z.enum(VISION_EVENT_TYPES).optional(),
    primaryPlayerId: cuidOrUuid.optional().nullable(),
    secondaryPlayerId: cuidOrUuid.optional().nullable(),
    teamSide: z.enum(TEAM_SIDES).optional(),
    pitchX: z.number().min(0).max(100).optional().nullable(),
    pitchY: z.number().min(0).max(100).optional().nullable(),
    reason: z.string().min(4).max(2000),
  })
  .strict();

// ─── Analytics requests ──────────────────────────────────────────────────────

export const runAnalyticsSchema = z
  .object({
    kinds: z.array(z.enum(ANALYTICS_KINDS)).min(1).max(ANALYTICS_KINDS.length),
    teamSide: z.enum(TEAM_SIDES).optional(),
    playerId: cuidOrUuid.optional().nullable(),
    windowStartMs: z.number().int().min(0).optional(),
    windowEndMs: z.number().int().min(0).optional(),
  })
  .strict();

// ─── Fusion ──────────────────────────────────────────────────────────────────

export const runFusionSchema = z
  .object({
    matchId: cuidOrUuid.optional().nullable(),
    trainingSessionId: cuidOrUuid.optional().nullable(),
    windowMinutes: z.number().int().min(1).max(120).optional().default(1),
  })
  .strict()
  .refine((v) => !!(v.matchId || v.trainingSessionId), 'matchId or trainingSessionId required');

// ─── Clips ───────────────────────────────────────────────────────────────────

export const requestClipSchema = z
  .object({
    videoAssetId: cuidOrUuid,
    matchId: cuidOrUuid.optional().nullable(),
    trainingSessionId: cuidOrUuid.optional().nullable(),
    playerId: cuidOrUuid.optional().nullable(),
    sourceEventId: cuidOrUuid.optional().nullable(),
    purpose: z.enum(CLIP_PURPOSES),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    title: z.string().max(200).optional().nullable(),
    description: z.string().max(2000).optional().nullable(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional().default([]),
    watermarkText: z.string().max(80).optional().nullable(),
  })
  .strict()
  .refine((v) => v.endMs > v.startMs, 'endMs must be greater than startMs');

export const generateHighlightsSchema = z
  .object({
    videoAssetId: cuidOrUuid,
    matchId: cuidOrUuid.optional().nullable(),
    eventTypes: z.array(z.enum(VISION_EVENT_TYPES)).min(1).max(VISION_EVENT_TYPES.length),
    perEventLeadMs: z.number().int().min(0).max(15000).default(5000),
    perEventTrailMs: z.number().int().min(0).max(15000).default(5000),
    maxClips: z.number().int().min(1).max(200).default(20),
    minConfidence: z.number().min(0).max(1).default(0.6),
  })
  .strict();

export const clipRenderCallbackSchema = z
  .object({
    status: z.enum(['RENDERING', 'READY', 'FAILED', 'EXPIRED', 'CANCELLED']),
    url: z.string().url().optional().nullable(),
    thumbnailUrl: z.string().url().optional().nullable(),
    durationMs: z.number().int().min(0).optional().nullable(),
    bytes: z.number().int().min(0).optional().nullable(),
    error: z.string().max(2000).optional().nullable(),
  })
  .strict();

// ─── Scouting ────────────────────────────────────────────────────────────────

export const generateScoutingSchema = z
  .object({
    kind: z.enum(SCOUTING_KINDS),
    matchId: cuidOrUuid.optional().nullable(),
    opponentName: z.string().max(200).optional().nullable(),
    targetPlayerId: cuidOrUuid.optional().nullable(),
    targetClubId: cuidOrUuid.optional().nullable(),
    analysisId: cuidOrUuid.optional().nullable(),
    title: z.string().min(1).max(200),
    notes: z.string().max(5000).optional().nullable(),
  })
  .strict();

// ─── Live streams ────────────────────────────────────────────────────────────

export const upsertLiveStreamSchema = z
  .object({
    streamUrl: z.string().url().optional().nullable(),
    ingestJobId: cuidOrUuid.optional().nullable(),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const publishLiveEventSchema = z
  .object({
    type: z.enum(VISION_EVENT_TYPES),
    occurredAtMs: z.number().int().min(0),
    primaryPlayerId: cuidOrUuid.optional().nullable(),
    secondaryPlayerId: cuidOrUuid.optional().nullable(),
    teamSide: z.enum(TEAM_SIDES).default('UNKNOWN'),
    pitchX: z.number().min(0).max(100).optional().nullable(),
    pitchY: z.number().min(0).max(100).optional().nullable(),
    payload: z.record(z.unknown()).optional().nullable(),
    confidence: z.number().min(0).max(1).default(1),
  })
  .strict();

// ─── Audit query ─────────────────────────────────────────────────────────────

export const visionAuditQuerySchema = z
  .object({
    analysisId: cuidOrUuid.optional(),
    matchId: cuidOrUuid.optional(),
    userId: cuidOrUuid.optional(),
    action: z.string().min(1).max(80).optional(),
    category: z.enum([
      'INGEST', 'INFERENCE', 'TRACKING', 'EVENTS', 'ANALYTICS', 'FUSION',
      'CLIP', 'SCOUTING', 'REALTIME', 'OVERRIDE', 'ACCESS', 'OTHER',
    ]).optional(),
    from: iso8601.optional(),
    to: iso8601.optional(),
    cursor: cuidOrUuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

// ─── Inferred input types ────────────────────────────────────────────────────

export type RegisterVideoInput = z.infer<typeof registerVideoSchema>;
export type UpdateVideoInput = z.infer<typeof updateVideoSchema>;
export type StartIngestInput = z.infer<typeof startIngestSchema>;
export type TransitionIngestInput = z.infer<typeof transitionIngestSchema>;
export type InferenceResultsInput = z.infer<typeof inferenceResultsSchema>;
export type OverrideEventInput = z.infer<typeof overrideEventSchema>;
export type RunAnalyticsInput = z.infer<typeof runAnalyticsSchema>;
export type RunFusionInput = z.infer<typeof runFusionSchema>;
export type RequestClipInput = z.infer<typeof requestClipSchema>;
export type GenerateHighlightsInput = z.infer<typeof generateHighlightsSchema>;
export type ClipRenderCallbackInput = z.infer<typeof clipRenderCallbackSchema>;
export type GenerateScoutingInput = z.infer<typeof generateScoutingSchema>;
export type UpsertLiveStreamInput = z.infer<typeof upsertLiveStreamSchema>;
export type PublishLiveEventInput = z.infer<typeof publishLiveEventSchema>;
export type VisionAuditQueryInput = z.infer<typeof visionAuditQuerySchema>;
