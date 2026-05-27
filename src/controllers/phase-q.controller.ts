// Familista — Phase Q Controller (Football Intelligence Core)
// Target: src/controllers/phase-q.controller.ts
// ─────────────────────────────────────────────────────────────────────────────
// Bundled controller for all Phase Q domains:
//   Domain 1  — Match Events         (match-events/match-event.service)
//   Domain 2  — Player Statistics    (player-stats/player-stats.service)
//   Domain 3  — Workload & Injury    (workload/workload-science.service)
//   Domain 4  — Video Intelligence   (video/video-asset|clip|annotation.service)
//   Domain 5  — Transfer Intelligence(transfer/scouting|market.service)
//   Domain 6  — Competition Engine   (competition/competition.service)

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { BadRequestError } from '../utils/errors';
import { prisma } from '../config/database';

// Domain 1
import * as MatchEventSvc  from '../match-events/match-event.service';
// Domain 2
import * as PlayerStatsSvc from '../player-stats/player-stats.service';
// Domain 3
import * as WorkloadSvc    from '../workload/workload-science.service';
// Domain 4
import * as VideoAssetSvc  from '../video/video-asset.service';
import * as VideoClipSvc   from '../video/video-clip.service';
import * as VideoAnnSvc    from '../video/video-annotation.service';
// Domain 5
import * as ScoutingSvc    from '../transfer/scouting.service';
import * as MarketSvc      from '../transfer/market.service';
import * as ScoringSvc     from '../transfer/scoring.service';
// Phase 11 — Unified Intelligence
import * as UnifiedSvc     from '../intelligence/unified.service';
import * as SuccessionSvc  from '../intelligence/succession.service';
// Domain 6
import * as CompetitionSvc from '../competition/competition.service';

// ─── Actor helpers ────────────────────────────────────────────────────────────

function actor(req: Request): { userId: string; clubId: string; role?: string } {
  return {
    userId: (req as any).user?.id      ?? '',
    clubId: (req as any).user?.clubId  ?? '',
    role:   (req as any).user?.role,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 1 — Match Events
// ─────────────────────────────────────────────────────────────────────────────

export async function recordEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await MatchEventSvc.recordEvent(actor(req), req.body);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function batchIngestEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { matchId, events, source } = req.body;
    const result = await MatchEventSvc.batchIngestEvents(actor(req), matchId, events, source);
    res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function listEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { matchId } = req.params;
    const opts: MatchEventSvc.ListEventsOpts = {
      type:        req.query.type        as string | undefined,
      playerId:    req.query.playerId    as string | undefined,
      teamId:      req.query.teamId      as string | undefined,
      periodIndex: req.query.periodIndex ? +req.query.periodIndex : undefined,
      fromMinute:  req.query.fromMinute  ? +req.query.fromMinute  : undefined,
      toMinute:    req.query.toMinute    ? +req.query.toMinute    : undefined,
      limit:       req.query.limit       ? +req.query.limit       : undefined,
      offset:      req.query.offset      ? +req.query.offset      : undefined,
    };
    const result = await MatchEventSvc.listEvents(actor(req), matchId, opts);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getEventSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await MatchEventSvc.getEventSummary(actor(req), req.params.matchId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function deleteEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await MatchEventSvc.deleteEvent(actor(req), req.params.id);
    res.status(204).end();
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 2 — Player Statistics
// ─────────────────────────────────────────────────────────────────────────────

export async function computeMatchStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await PlayerStatsSvc.computeMatchStats(req.params.matchId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getMatchStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await PlayerStatsSvc.getMatchStats(req.params.matchId, req.params.playerId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listMatchStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await PlayerStatsSvc.listMatchStats(req.params.matchId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getSeasonStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { playerId } = req.params;
    const { season, clubId } = req.query as Record<string, string>;
    const result = await PlayerStatsSvc.getSeasonStats(playerId, season, clubId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getPlayerProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await PlayerStatsSvc.getPlayerProfile(req.params.playerId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function rollupSeasonStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { playerId, clubId, season, competitionId } = req.body;
    const result = await PlayerStatsSvc.rollupSeasonStats(playerId, clubId, season, competitionId);
    res.json(result);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 3 — Workload & Injury
// ─────────────────────────────────────────────────────────────────────────────

export async function ingestGPSSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await WorkloadSvc.ingestGPSSession(actor(req), req.body);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function recomputeWorkload(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await WorkloadSvc.recomputeWorkload(actor(req), req.params.playerId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function squadReadiness(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await WorkloadSvc.squadReadiness(actor(req), req.params.teamId);
    res.json(result);
  } catch (err) { next(err); }
}

// ── Injury schemas ────────────────────────────────────────────────────────────
const DATE_STR = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Must be YYYY-MM-DD or ISO datetime');

const createInjurySchema = z.object({
  playerId:       z.string().uuid('playerId must be a UUID'),
  injuryDate:     DATE_STR,
  bodyLocation:   z.string().trim().min(1).max(200),
  osicsCategory:  z.string().trim().max(200).optional(),
  mechanism:      z.enum(['UNKNOWN','TRAINING','MATCH','IMPACT','OVERUSE']).optional(),
  severity:       z.enum(['MINOR','MODERATE','MAJOR','CRITICAL']).optional(),
  isContactInjury: z.boolean().optional(),
  isRecurrence:   z.boolean().optional(),
  notes:          z.string().max(4000).optional(),
  returnDate:     DATE_STR.nullable().optional(),
});

const updateInjurySchema = z.object({
  injuryDate:     DATE_STR.optional(),
  bodyLocation:   z.string().trim().min(1).max(200).optional(),
  osicsCategory:  z.string().trim().max(200).optional(),
  mechanism:      z.enum(['UNKNOWN','TRAINING','MATCH','IMPACT','OVERUSE']).optional(),
  severity:       z.enum(['MINOR','MODERATE','MAJOR','CRITICAL']).optional(),
  isContactInjury: z.boolean().optional(),
  isRecurrence:   z.boolean().optional(),
  notes:          z.string().max(4000).optional(),
  returnDate:     DATE_STR.nullable().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields supplied to update' });

function injZerr(err: z.ZodError): BadRequestError {
  return new BadRequestError(
    err.errors.map((e) => `${e.path.join('.') || 'body'}: ${e.message}`).join(', '),
  );
}

export async function recordInjury(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createInjurySchema.safeParse(req.body);
    if (!parsed.success) { next(injZerr(parsed.error)); return; }
    const result = await WorkloadSvc.recordInjury(actor(req), parsed.data as any);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

// Bug fixed: was passing req.body (object) → service received object instead of string.
export async function updateInjuryReturn(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const returnDate = req.body && req.body.returnDate;
    if (!returnDate || typeof returnDate !== 'string') { next(new BadRequestError('returnDate (string) is required')); return; }
    const result = await WorkloadSvc.updateInjuryReturn(actor(req), req.params.injuryId, returnDate);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listInjuries(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await WorkloadSvc.listInjuries(actor(req), {
      playerId:   req.query.playerId  as string | undefined,
      teamId:     req.query.teamId    as string | undefined,
      activeOnly: req.query.active === 'true' ? true : undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
}

export async function getInjury(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await WorkloadSvc.getInjuryById(actor(req), req.params.injuryId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function updateInjury(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateInjurySchema.safeParse(req.body);
    if (!parsed.success) { next(injZerr(parsed.error)); return; }
    const result = await WorkloadSvc.updateInjury(actor(req), req.params.injuryId, parsed.data);
    res.json(result);
  } catch (err) { next(err); }
}

export async function deleteInjury(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await WorkloadSvc.deleteInjury(actor(req), req.params.injuryId);
    res.status(204).send();
  } catch (err) { next(err); }
}

export async function getPlayerMedicalProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await WorkloadSvc.getPlayerMedicalProfile(actor(req), req.params.playerId);
    res.json(result);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 4 — Video Intelligence
// ─────────────────────────────────────────────────────────────────────────────

// Assets
export async function requestVideoUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoAssetSvc.requestUpload(actor(req), req.body);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function confirmVideoUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoAssetSvc.confirmUpload(actor(req), req.body);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getVideoStreamUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoAssetSvc.getStreamUrl(actor(req), req.params.assetId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listVideoAssets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoAssetSvc.listAssets(actor(req), {
      matchId:    req.query.matchId    as string | undefined,
      teamId:     req.query.teamId     as string | undefined,
      sourceKind: req.query.sourceKind as string | undefined,
      status:     req.query.status     as string | undefined,
      limit:      req.query.limit      ? +req.query.limit  : undefined,
      offset:     req.query.offset     ? +req.query.offset : undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
}

export async function getVideoAsset(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoAssetSvc.getAsset(actor(req), req.params.assetId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function deleteVideoAsset(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await VideoAssetSvc.deleteAsset(actor(req), req.params.assetId);
    res.status(204).end();
  } catch (err) { next(err); }
}

// Transcode callback — called by VideoTranscodeWorker (internal, no auth guard needed in route)
export async function handleTranscodeCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoAssetSvc.handleTranscodeCallback(req.body);
    res.json(result);
  } catch (err) { next(err); }
}

// HLS streaming proxy — pipes S3 bytes through Express so the browser never
// hits S3 directly (no CORS / presigned URL complexity for hls.js).
// Route: GET /video/assets/:assetId/hls/:filename
export async function streamHlsFile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { assetId, filename } = req.params;
    const stream = await VideoAssetSvc.streamHlsFile(actor(req), assetId, filename);

    res.setHeader('Content-Type', stream.contentType);
    // Allow browser and hls.js to cache segments for 5 min; never cache the manifest.
    if (filename.endsWith('.ts')) {
      res.setHeader('Cache-Control', 'public, max-age=300');
    } else {
      res.setHeader('Cache-Control', 'no-cache, no-store');
    }

    stream.body.pipe(res);
    stream.body.on('error', next);
  } catch (err) { next(err); }
}

// Clips
export async function createVideoClip(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoClipSvc.createClip(actor(req), req.body);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function updateVideoClip(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoClipSvc.updateClip(actor(req), req.params.clipId, req.body);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getVideoClip(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoClipSvc.getClip(actor(req), req.params.clipId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listVideoClips(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoClipSvc.listClips(actor(req), {
      assetId:  req.query.assetId  as string | undefined,
      playerId: req.query.playerId as string | undefined,
      matchId:  req.query.matchId  as string | undefined,
      limit:    req.query.limit    ? +req.query.limit  : undefined,
      offset:   req.query.offset   ? +req.query.offset : undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
}

export async function deleteVideoClip(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await VideoClipSvc.deleteClip(actor(req), req.params.clipId);
    res.status(204).end();
  } catch (err) { next(err); }
}

export async function shareVideoClip(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoClipSvc.shareClip(actor(req), { ...req.body, clipId: req.params.clipId });
    res.json(result);
  } catch (err) { next(err); }
}

export async function revokeVideoShare(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoClipSvc.revokeShare(actor(req), req.params.clipId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getSharedClip(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoClipSvc.getClipByShareToken(req.params.shareToken);
    res.json(result);
  } catch (err) { next(err); }
}

// Playlists
export async function createVideoPlaylist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoClipSvc.createPlaylist(actor(req), req.body);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function getVideoPlaylist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoClipSvc.getPlaylist(actor(req), req.params.playlistId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listVideoPlaylists(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoClipSvc.listPlaylists(actor(req), {
      teamId: req.query.teamId as string | undefined,
      limit:  req.query.limit  ? +req.query.limit  : undefined,
      offset: req.query.offset ? +req.query.offset : undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
}

export async function addClipToPlaylist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoClipSvc.addClipToPlaylist(actor(req), req.params.playlistId, req.body.clipId);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function removeClipFromPlaylist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await VideoClipSvc.removeClipFromPlaylist(actor(req), req.params.playlistId, req.params.clipId);
    res.status(204).end();
  } catch (err) { next(err); }
}

export async function reorderPlaylist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await VideoClipSvc.reorderPlaylist(actor(req), req.params.playlistId, req.body.orderedClipIds);
    res.status(204).end();
  } catch (err) { next(err); }
}

export async function deleteVideoPlaylist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await VideoClipSvc.deletePlaylist(actor(req), req.params.playlistId);
    res.status(204).end();
  } catch (err) { next(err); }
}

// Annotations
export async function createAnnotation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoAnnSvc.createAnnotation(actor(req), req.body);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function updateAnnotation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoAnnSvc.updateAnnotation(actor(req), req.params.annotationId, req.body);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listAnnotations(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoAnnSvc.listAnnotations(actor(req), req.params.clipId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function deleteAnnotation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await VideoAnnSvc.deleteAnnotation(actor(req), req.params.annotationId);
    res.status(204).end();
  } catch (err) { next(err); }
}

export async function replaceAnnotations(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await VideoAnnSvc.replaceAnnotations(actor(req), req.params.clipId, req.body.annotations);
    res.json(result);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 5 — Transfer Intelligence
// ─────────────────────────────────────────────────────────────────────────────

// Scouting reports
export async function createScoutingReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await ScoutingSvc.createScoutingReport(actor(req), req.body);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function updateScoutingReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await ScoutingSvc.updateScoutingReport(actor(req), req.params.reportId, req.body);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getScoutingReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await ScoutingSvc.getScoutingReport(actor(req), req.params.reportId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listScoutingReports(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await ScoutingSvc.listScoutingReports(actor(req), {
      playerId:       req.query.playerId       as string | undefined,
      scoutId:        req.query.scoutId        as string | undefined,
      recommendation: req.query.recommendation as string | undefined,
      overallGrade:   req.query.overallGrade   as string | undefined,
      limit:          req.query.limit          ? +req.query.limit  : undefined,
      offset:         req.query.offset         ? +req.query.offset : undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
}

export async function deleteScoutingReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await ScoutingSvc.deleteScoutingReport(actor(req), req.params.reportId);
    res.status(204).end();
  } catch (err) { next(err); }
}

// Transfer targets
export async function createTransferTarget(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await ScoutingSvc.createTransferTarget(actor(req), req.body);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function advanceTransferStage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { stage, note } = req.body;
    const result = await ScoutingSvc.advanceTransferStage(actor(req), req.params.targetId, stage, note);
    res.json(result);
  } catch (err) { next(err); }
}

export async function updateTransferTarget(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await ScoutingSvc.updateTransferTarget(actor(req), req.params.targetId, req.body);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listTransferTargets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await ScoutingSvc.listTransferTargets(actor(req), {
      stage:    req.query.stage    as string | undefined,
      archived: req.query.archived === 'true' ? true : req.query.archived === 'false' ? false : undefined,
      limit:    req.query.limit    ? +req.query.limit  : undefined,
      offset:   req.query.offset   ? +req.query.offset : undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
}

export async function getPipelineBoard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await ScoutingSvc.getPipelineBoard(actor(req));
    res.json(result);
  } catch (err) { next(err); }
}

// Market values
export async function recordMarketValue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await MarketSvc.recordMarketValue(actor(req), req.body);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function getMarketValueHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await MarketSvc.getMarketValueHistory(actor(req), req.params.playerId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getLatestMarketValue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await MarketSvc.getLatestMarketValue(actor(req), req.params.playerId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function squadValuationSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await MarketSvc.squadValuationSummary(actor(req), req.query.teamId as string | undefined);
    res.json(result);
  } catch (err) { next(err); }
}

// Contract status
export async function upsertContractStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await MarketSvc.upsertContractStatus(actor(req), req.body);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getContractStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await MarketSvc.getContractStatus(actor(req), req.params.playerId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getExpiringContracts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const withinDays = req.query.withinDays ? +req.query.withinDays : undefined;
    const result = await MarketSvc.getExpiringContracts(actor(req), withinDays);
    res.json(result);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 6 — Competition Engine
// ─────────────────────────────────────────────────────────────────────────────

export async function createCompetition(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await CompetitionSvc.createCompetition(actor(req), req.body);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function getCompetition(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await CompetitionSvc.getCompetition(actor(req), req.params.competitionId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listCompetitions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await CompetitionSvc.listCompetitions(actor(req), {
      season: req.query.season as string | undefined,
      format: req.query.format as string | undefined,
      limit:  req.query.limit  ? +req.query.limit  : undefined,
      offset: req.query.offset ? +req.query.offset : undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
}

export async function addTeamToCompetition(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await CompetitionSvc.addTeamToCompetition(actor(req), req.params.competitionId, req.body.teamId);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function removeTeamFromCompetition(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await CompetitionSvc.removeTeamFromCompetition(actor(req), req.params.competitionId, req.params.teamId);
    res.status(204).end();
  } catch (err) { next(err); }
}

export async function listTeamsInCompetition(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await CompetitionSvc.listTeamsInCompetition(req.params.competitionId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function createFixture(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await CompetitionSvc.createFixture(actor(req), req.body);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function updateFixture(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await CompetitionSvc.updateFixture(actor(req), req.params.fixtureId, req.body);
    res.json(result);
  } catch (err) { next(err); }
}

export async function recordResult(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await CompetitionSvc.recordResult(actor(req), { ...req.body, fixtureId: req.params.fixtureId });
    res.json(result);
  } catch (err) { next(err); }
}

export async function cancelFixture(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await CompetitionSvc.cancelFixture(actor(req), req.params.fixtureId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listFixtures(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await CompetitionSvc.listFixtures(actor(req), req.params.competitionId, {
      round:  req.query.round  ? +req.query.round : undefined,
      status: req.query.status as string | undefined,
      teamId: req.query.teamId as string | undefined,
      limit:  req.query.limit  ? +req.query.limit  : undefined,
      offset: req.query.offset ? +req.query.offset : undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
}

export async function generateRoundRobinFixtures(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { startDate, matchdayIntervalDays, homeLegOnly } = req.body;
    const result = await CompetitionSvc.generateRoundRobinFixtures(
      actor(req),
      req.params.competitionId,
      startDate,
      matchdayIntervalDays,
      homeLegOnly,
    );
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function getStandings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await CompetitionSvc.getStandings(actor(req), req.params.competitionId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function rebuildStandings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await CompetitionSvc.rebuildStandings(actor(req), req.params.competitionId);
    res.json(result);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 4 Additions — Video Intelligence Dashboard + Match Video Summary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /phase-q/video/dashboard
 * Aggregate KPIs for the Video Analysis & Match Intelligence Center.
 * Pulls from VideoAsset + VideoClip + VideoPlaylist using existing service calls.
 * Response: { totalAssets, readyAssets, totalClips, totalPlaylists, assetsByStatus, recentAssets }
 */
export async function getVideoDashboard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const a = actor(req);
    // Fetch assets (up to 100 most recent) + clip total + playlist total in parallel.
    const [assetsRes, clipsRes, playlistsRes] = await Promise.all([
      VideoAssetSvc.listAssets(a, { limit: 100 }),
      VideoClipSvc.listClips(a, { limit: 1 }),
      VideoClipSvc.listPlaylists(a, { limit: 1 }),
    ]);

    // Build status breakdown from returned items.
    const byStatus: Record<string, number> = {};
    for (const asset of assetsRes.items) {
      byStatus[asset.status] = (byStatus[asset.status] ?? 0) + 1;
    }

    res.json({
      totalAssets:    assetsRes.total,
      readyAssets:    byStatus['READY'] ?? 0,
      totalClips:     clipsRes.total,
      totalPlaylists: playlistsRes.total,
      assetsByStatus: byStatus,
      recentAssets:   assetsRes.items.slice(0, 6),
    });
  } catch (err) { next(err); }
}

/**
 * GET /phase-q/video/match/:matchId/summary
 * Per-match aggregate: video assets + clips + event type counts.
 * Combines three existing service calls into one response so the frontend
 * can power the Opponent Analysis and Match Summary tabs with a single request.
 * Response: { videoAssets: {items, total}, clips: {items, total}, eventSummary: {TYPE: count} }
 */
export async function getMatchVideoSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const a = actor(req);
    const { matchId } = req.params;
    if (!matchId) { res.status(400).json({ error: 'matchId is required' }); return; }

    const [videoAssets, clips, eventSummary] = await Promise.all([
      VideoAssetSvc.listAssets(a, { matchId, limit: 50 }),
      VideoClipSvc.listClips(a, { matchId, limit: 100 }),
      MatchEventSvc.getEventSummary(a, matchId),
    ]);

    res.json({ videoAssets, clips, eventSummary });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 5 — Transfer Intelligence (aggregate / cross-module)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /phase-q/transfer/intelligence/player/:playerId
 * Cross-module player intelligence card.
 * Aggregates scouting reports, market value history, contract status,
 * medical profile, and video clips into a single response for the
 * Transfer Intelligence Center player detail view.
 */
export async function getPlayerTransferIntelligence(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const a = actor(req);
    const { playerId } = req.params;

    const [reports, marketHistory, contract, medical, clips] = await Promise.allSettled([
      ScoutingSvc.listScoutingReports(a, { playerId, limit: 50 }),
      MarketSvc.getMarketValueHistory(a, playerId),
      MarketSvc.getContractStatus(a, playerId),
      WorkloadSvc.getPlayerMedicalProfile(a, playerId),
      VideoClipSvc.listClips(a, { playerId, limit: 20 }),
    ]);

    res.json({
      playerId,
      reports:       reports.status       === 'fulfilled' ? reports.value       : { items: [], total: 0 },
      marketHistory: marketHistory.status === 'fulfilled' ? marketHistory.value : [],
      contract:      contract.status      === 'fulfilled' ? contract.value      : null,
      medical:       medical.status       === 'fulfilled' ? medical.value       : null,
      clips:         clips.status         === 'fulfilled' ? clips.value         : { items: [], total: 0 },
    });
  } catch (err) { next(err); }
}

/**
 * GET /phase-q/transfer/intelligence/squad
 * Squad-level transfer intelligence: age/position distribution,
 * total wage bill, valuations, and contracts expiring within 365 days.
 * Used by the Market Intelligence tab in the Transfer Intelligence Center.
 */
export async function getSquadTransferIntelligence(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const a = actor(req);

    const [players, valuations, expiringContracts] = await Promise.all([
      prisma.player.findMany({
        where:  { clubId: a.clubId, isActive: true },
        select: { id: true, position: true, dateOfBirth: true, weeklyWage: true, isInjured: true },
      }),
      MarketSvc.squadValuationSummary(a),
      MarketSvc.getExpiringContracts(a, 365),
    ]);

    // Age distribution
    const today = new Date();
    const ageBands: Record<string, number> = { 'U18': 0, '18-21': 0, '22-25': 0, '26-29': 0, '30+': 0 };
    for (const p of players) {
      const age = Math.floor((today.getTime() - new Date(p.dateOfBirth).getTime()) / 31_557_600_000);
      if      (age < 18)  ageBands['U18']++;
      else if (age <= 21) ageBands['18-21']++;
      else if (age <= 25) ageBands['22-25']++;
      else if (age <= 29) ageBands['26-29']++;
      else                ageBands['30+']++;
    }

    // Position distribution
    const positionCounts: Record<string, number> = {};
    for (const p of players) {
      positionCounts[p.position] = (positionCounts[p.position] ?? 0) + 1;
    }

    // Wage bill (weekly → annual)
    const totalWeeklyWage  = players.reduce((s, p) => s + (p.weeklyWage ?? 0), 0);
    const annualWageBillEur = totalWeeklyWage * 52;

    // Squad value total
    const totalSquadValueMEur = valuations.reduce((s, v) => s + v.latestValueMEur, 0);

    res.json({
      squadSize:          players.length,
      injuredCount:       players.filter((p) => p.isInjured).length,
      ageBands,
      positionCounts,
      annualWageBillEur,
      totalSquadValueMEur: +totalSquadValueMEur.toFixed(2),
      valuations,
      expiringContracts,
    });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 5 — Transfer Intelligence (Phase 10 scoring engine)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /phase-q/transfer/scoring/ranked
 * Compute and return the full ranked scorecard for all active transfer targets.
 * Each entry includes compositeScore, tacticalFitScore, contractRiskScore,
 * transferPriority, marketOpportunity, flags, and auto-generated scoutingSummary.
 */
export async function getRankedTargets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await ScoringSvc.getRankedTargets(actor(req));
    res.json({ items: result, total: result.length });
  } catch (err) { next(err); }
}

/**
 * GET /phase-q/transfer/scoring/squad-depth
 * Return position-group depth analysis: shortages, surpluses, critical slots.
 */
export async function getSquadDepthAnalysis(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await ScoringSvc.getSquadDepthAnalysis(actor(req));
    res.json(result);
  } catch (err) { next(err); }
}

/**
 * POST /phase-q/transfer/scoring/scorecard
 * Compute a single scorecard on demand from request body inputs.
 * Useful for the Compare tab and player profile without saving anything.
 * Body: ScorecardInput (reports[], contract?, latestValueMEur, askingPriceMEur, etc.)
 */
export async function computeSingleScorecard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = req.body as ScoringSvc.ScorecardInput;
    if (!body?.playerId) { res.status(400).json({ error: 'playerId required' }); return; }
    const scorecard = ScoringSvc.buildScorecard(body);
    res.json(scorecard);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 5 — Unified Intelligence Engine (Phase 11)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /phase-q/transfer/intelligence/unified/:playerId
 * Full cross-module intelligence report: scouting + medical + video +
 * contract + market aggregated into one explainable scorecard.
 */
export async function getUnifiedPlayerIntelligence(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { playerId } = req.params;
    if (!playerId) { res.status(400).json({ error: 'playerId required' }); return; }
    const result = await UnifiedSvc.getUnifiedPlayerIntelligence(actor(req), playerId);
    res.json(result);
  } catch (err) { next(err); }
}

/**
 * GET /phase-q/transfer/intelligence/squad-summary
 * Lightweight squad overview: top players by scouting score + squad future plan.
 */
export async function getSquadIntelligenceSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await UnifiedSvc.getSquadIntelligenceSummary(actor(req));
    res.json(result);
  } catch (err) { next(err); }
}

/**
 * GET /phase-q/transfer/intelligence/succession/:position
 * Returns squad players who can cover the specified position, ranked by
 * compatibility and age (youngest first for long-term succession).
 */
export async function getSuccessionCandidates(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { position } = req.params;
    if (!position) { res.status(400).json({ error: 'position required' }); return; }
    const result = await SuccessionSvc.getSuccessionCandidates(actor(req), position.toUpperCase());
    res.json({ position: position.toUpperCase(), items: result, total: result.length });
  } catch (err) { next(err); }
}

/**
 * GET /phase-q/transfer/intelligence/squad-future
 * Squad-level future planning: age curves, contract cliffs, succession coverage
 * per position group, overall health score, and critical alerts.
 */
export async function getSquadFuturePlan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await SuccessionSvc.getSquadFuturePlan(actor(req));
    res.json(result);
  } catch (err) { next(err); }
}
