// Familista — Vision Intelligence Engine
// File location: src/controllers/vision-engine.controller.ts
//
// Consolidated HTTP handlers. Sections (ToC):
//   1.  Video assets
//   2.  Ingest jobs
//   3.  Analysis runs + tracks
//   4.  Events (read + override)
//   5.  Analytics (run + read)
//   6.  Sensor + vision fusion
//   7.  Clips
//   8.  Scouting
//   9.  Live streams (SSE + publish)
//  10.  Webhooks (inference + clip — workers post here)
//  11.  Audit

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import * as ingest from '../services/vision-ingest.service';
import * as tracking from '../services/vision-tracking.service';
import * as events from '../services/vision-events.service';
import * as analytics from '../services/vision-analytics.service';
import * as fusion from '../services/vision-fusion.service';
import * as clipsSvc from '../services/vision-clip.service';
import * as scouting from '../services/vision-scouting.service';
import * as realtime from '../services/vision-realtime.service';
import * as audit from '../services/vision-audit.service';

import {
  assertVideoAccess,
  assertAnalysisAccess,
  assertMatchAccess,
} from '../middleware/vision-access.middleware';

import {
  registerVideoSchema,
  updateVideoSchema,
  startIngestSchema,
  transitionIngestSchema,
  inferenceResultsSchema,
  overrideEventSchema,
  runAnalyticsSchema,
  runFusionSchema,
  requestClipSchema,
  generateHighlightsSchema,
  clipRenderCallbackSchema,
  generateScoutingSchema,
  upsertLiveStreamSchema,
  publishLiveEventSchema,
  visionAuditQuerySchema,
} from '../utils/vision.validators';

import { sendSuccess, sendCreated, sendNoContent } from '../utils/response';
import { BadRequestError, ForbiddenError } from '../utils/errors';

function actorOf(req: Request) {
  if (!req.visionActor) throw new ForbiddenError('Vision context required');
  return req.visionActor;
}
function zerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(err.errors.map((e) => `${e.path.join('.') || 'body'}: ${e.message}`).join(', '));
}

// ─── 1. Videos ──────────────────────────────────────────────────────────────

export async function registerVideo(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = registerVideoSchema.parse(req.body);
    return sendCreated(res, await ingest.registerVideo(actor, input), 'Video registered');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function listVideos(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await ingest.listVideos({
      clubId: req.query.clubId as string | undefined,
      matchId: req.query.matchId as string | undefined,
      trainingSessionId: req.query.trainingSessionId as string | undefined,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getVideo(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertVideoAccess(actor, req.params.id, 'read');
    return sendSuccess(res, await ingest.getVideo(req.params.id));
  } catch (err) { return next(err); }
}

export async function updateVideo(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertVideoAccess(actor, req.params.id, 'write');
    const input = updateVideoSchema.parse(req.body);
    return sendSuccess(res, await ingest.updateVideo(actor, req.params.id, input), 'Video updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 2. Ingest jobs ────────────────────────────────────────────────────────

export async function startIngest(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertVideoAccess(actor, req.params.id, 'write');
    const input = startIngestSchema.parse(req.body ?? {});
    return sendCreated(res, await ingest.startIngest(actor, req.params.id, input), 'Ingest started');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function getIngestJob(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await ingest.getIngestJob(req.params.jobId));
  } catch (err) { return next(err); }
}

export async function transitionIngest(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = transitionIngestSchema.parse(req.body);
    return sendSuccess(res, await ingest.transitionIngest(actor, req.params.jobId, input), 'Ingest stage updated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 3. Analysis runs + tracks ─────────────────────────────────────────────

export async function listAnalyses(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await tracking.listAnalyses({
      matchId: req.query.matchId as string | undefined,
      clubId: req.query.clubId as string | undefined,
      trainingSessionId: req.query.trainingSessionId as string | undefined,
      videoAssetId: req.query.videoAssetId as string | undefined,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getAnalysis(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertAnalysisAccess(actor, req.params.id, 'read');
    return sendSuccess(res, await tracking.getAnalysis(req.params.id));
  } catch (err) { return next(err); }
}

export async function listPlayerTracks(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertAnalysisAccess(actor, req.params.id, 'read');
    return sendSuccess(res, await tracking.listPlayerTracks({
      analysisId: req.params.id,
      playerId: req.query.playerId as string | undefined,
      teamSide: req.query.teamSide as never,
      fromMs: req.query.fromMs ? Number(req.query.fromMs) : undefined,
      toMs: req.query.toMs ? Number(req.query.toMs) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function listBallTracks(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertAnalysisAccess(actor, req.params.id, 'read');
    return sendSuccess(res, await tracking.listBallTracks({
      analysisId: req.params.id,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function playerTrackSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertAnalysisAccess(actor, req.params.id, 'read');
    return sendSuccess(res, await tracking.playerTrackSummary({
      analysisId: req.params.id,
      teamSide: req.query.teamSide as never,
    }));
  } catch (err) { return next(err); }
}

// ─── 4. Events ─────────────────────────────────────────────────────────────

export async function listEvents(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await events.listEvents({
      analysisId: req.query.analysisId as string | undefined,
      matchId: req.query.matchId as string | undefined,
      type: req.query.type as never,
      playerId: req.query.playerId as string | undefined,
      teamSide: req.query.teamSide as never,
      fromMs: req.query.fromMs ? Number(req.query.fromMs) : undefined,
      toMs: req.query.toMs ? Number(req.query.toMs) : undefined,
      minConfidence: req.query.minConfidence ? Number(req.query.minConfidence) : undefined,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getEvent(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await events.getEvent(req.params.id));
  } catch (err) { return next(err); }
}

export async function overrideEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = overrideEventSchema.parse(req.body);
    return sendSuccess(res, await events.overrideEvent(actor, req.params.id, input), 'Event overridden');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function eventCounts(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await events.eventTypeCounts({
      analysisId: req.query.analysisId as string | undefined,
      matchId: req.query.matchId as string | undefined,
      teamSide: req.query.teamSide as never,
    }));
  } catch (err) { return next(err); }
}

// ─── 5. Analytics ──────────────────────────────────────────────────────────

export async function runAnalytics(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertAnalysisAccess(actor, req.params.id, 'write');
    const input = runAnalyticsSchema.parse(req.body);
    return sendSuccess(res, await analytics.runAnalytics(actor, req.params.id, input), 'Analytics computed');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function listAnalytics(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await analytics.listAnalytics({
      analysisId: req.query.analysisId as string | undefined,
      matchId: req.query.matchId as string | undefined,
      playerId: req.query.playerId as string | undefined,
      kind: req.query.kind as never,
      teamSide: req.query.teamSide as never,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getLatestMatchAnalytic(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertMatchAccess(actor, req.params.matchId, 'read');
    const kind = req.params.kind as never;
    return sendSuccess(res, await analytics.getAnalyticsLatest({
      matchId: req.params.matchId,
      kind,
      teamSide: req.query.teamSide as never,
      playerId: req.query.playerId as string | undefined,
    }));
  } catch (err) { return next(err); }
}

// ─── 6. Fusion ─────────────────────────────────────────────────────────────

export async function runFusion(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = runFusionSchema.parse(req.body);
    if (input.matchId) await assertMatchAccess(actor, input.matchId, 'write');
    return sendSuccess(res, await fusion.runFusion(actor, input), 'Fusion computed');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function listFusion(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await fusion.listFusedSamples({
      matchId: req.query.matchId as string | undefined,
      trainingSessionId: req.query.trainingSessionId as string | undefined,
      playerId: req.query.playerId as string | undefined,
      fromMs: req.query.fromMs ? Number(req.query.fromMs) : undefined,
      toMs: req.query.toMs ? Number(req.query.toMs) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

// ─── 7. Clips ──────────────────────────────────────────────────────────────

export async function requestClip(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = requestClipSchema.parse(req.body);
    await assertVideoAccess(actor, input.videoAssetId, 'write');
    return sendCreated(res, await clipsSvc.requestClip(actor, input), 'Clip queued');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function generateHighlights(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = generateHighlightsSchema.parse(req.body);
    await assertVideoAccess(actor, input.videoAssetId, 'write');
    return sendCreated(res, await clipsSvc.generateHighlights(actor, input), 'Highlight clips queued');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function listClips(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await clipsSvc.listClips({
      videoAssetId: req.query.videoAssetId as string | undefined,
      matchId: req.query.matchId as string | undefined,
      trainingSessionId: req.query.trainingSessionId as string | undefined,
      playerId: req.query.playerId as string | undefined,
      purpose: req.query.purpose as never,
      status: req.query.status as never,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getClip(req: Request, res: Response, next: NextFunction) {
  try { actorOf(req); return sendSuccess(res, await clipsSvc.getClip(req.params.id)); }
  catch (err) { return next(err); }
}

// ─── 8. Scouting ───────────────────────────────────────────────────────────

export async function generateScouting(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    const input = generateScoutingSchema.parse(req.body);
    if (input.matchId) await assertMatchAccess(actor, input.matchId, 'read');
    return sendCreated(res, await scouting.generateScoutingReport(actor, input), 'Scouting report generated');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function listScouting(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    return sendSuccess(res, await scouting.listScoutingReports({
      kind: req.query.kind as never,
      matchId: req.query.matchId as string | undefined,
      targetPlayerId: req.query.targetPlayerId as string | undefined,
      targetClubId: req.query.targetClubId as string | undefined,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getScouting(req: Request, res: Response, next: NextFunction) {
  try { actorOf(req); return sendSuccess(res, await scouting.getScoutingReport(req.params.id)); }
  catch (err) { return next(err); }
}

// ─── 9. Live streams ───────────────────────────────────────────────────────

export async function upsertLiveStream(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertMatchAccess(actor, req.params.matchId, 'write');
    const input = upsertLiveStreamSchema.parse(req.body ?? {});
    return sendSuccess(res, await realtime.upsertStream(actor, req.params.matchId, input));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function transitionLive(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertMatchAccess(actor, req.params.matchId, 'write');
    const status = String(req.body?.status ?? '');
    if (!['IDLE', 'LIVE', 'PAUSED', 'ENDED'].includes(status)) throw new BadRequestError('Invalid status');
    return sendSuccess(res, await realtime.transitionStream(actor, req.params.matchId, status as never), 'Stream updated');
  } catch (err) { return next(err); }
}

export async function publishLiveEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertMatchAccess(actor, req.params.matchId, 'write');
    const input = publishLiveEventSchema.parse(req.body);
    return sendCreated(res, await realtime.publishLiveEvent(actor, req.params.matchId, input));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function subscribeLive(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertMatchAccess(actor, req.params.matchId, 'read');
    await realtime.subscribeSse(actor, req.params.matchId, res);
    // Do not call next — SSE keeps the response open
  } catch (err) { return next(err); }
}

export async function listLiveEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertMatchAccess(actor, req.params.matchId, 'read');
    return sendSuccess(res, await realtime.listLiveEvents({
      matchId: req.params.matchId,
      fromMs: req.query.fromMs ? Number(req.query.fromMs) : undefined,
      toMs: req.query.toMs ? Number(req.query.toMs) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (err) { return next(err); }
}

export async function getLiveStream(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await assertMatchAccess(actor, req.params.matchId, 'read');
    return sendSuccess(res, await realtime.getStream(req.params.matchId));
  } catch (err) { return next(err); }
}

// ─── 10. Webhooks (worker → us) ────────────────────────────────────────────

export async function inferenceResultsWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const input = inferenceResultsSchema.parse(req.body);
    const updated = await ingest.ingestInferenceResults(null, req.params.jobId, input);
    return sendSuccess(res, updated, 'Inference results ingested');
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function ingestFailureWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const error = String(req.body?.error ?? 'unknown failure');
    return sendSuccess(res, await ingest.failIngest(null, req.params.jobId, error));
  } catch (err) { return next(err); }
}

export async function clipRenderWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const input = clipRenderCallbackSchema.parse(req.body);
    return sendSuccess(res, await clipsSvc.applyRenderCallback(req.params.externalRenderId, input));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

// ─── 11. Audit ─────────────────────────────────────────────────────────────

export async function searchAudit(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const q = visionAuditQuerySchema.parse(req.query);
    return sendSuccess(res, await audit.searchVisionAudit(q));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

export async function summarizeAudit(req: Request, res: Response, next: NextFunction) {
  try {
    actorOf(req);
    const q = visionAuditQuerySchema.parse(req.query);
    return sendSuccess(res, await audit.summarizeVisionAudit(q));
  } catch (err) {
    if (err instanceof z.ZodError) return next(zerr(err));
    return next(err);
  }
}

void sendNoContent;
