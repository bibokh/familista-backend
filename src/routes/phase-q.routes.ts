// Familista — Phase Q Routes (Football Intelligence Core)
// Target: src/routes/phase-q.routes.ts
// Mounted at: /api/v1/phase-q
// ─────────────────────────────────────────────────────────────────────────────
// All routes require an authenticated session (JWT middleware upstream in app.ts).
// Club-scope isolation is enforced inside each service via actor.clubId checks.
//
// Domain layout:
//   /events          — Match Event Engine (record, batch ingest, list, delete)
//   /stats           — Player Statistics (per-match rebuild, season rollup, profile)
//   /workload        — Workload & Injury science (GPS ingest, ATL/CTL/TSB, injuries)
//   /video           — Video Intelligence (assets, clips, playlists, annotations)
//   /transfer        — Transfer Intelligence (scouting, market values, contracts)
//   /competitions    — Competition Engine (leagues, fixtures, standings)

import { Router } from 'express';
import * as C from '../controllers/phase-q.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC routes — no JWT required (share token IS the credential).
// These MUST be registered before router.use(authenticate) below.
// ─────────────────────────────────────────────────────────────────────────────

// Public shared-clip lookup: the caller supplies a share token, not a Bearer JWT.
// Service validates the token and enforces expiry server-side.
router.get('/video/shared/:shareToken', C.getSharedClip);

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATED routes — all routes below this line require a valid JWT session.
// The transcode callback is the sole exception — it is called by the
// internal VideoTranscodeWorker via direct function import, not over HTTP.
// If an external transcode provider needs this endpoint it must add a
// X-Worker-Secret header validated here; for now the worker bypasses HTTP.
// ─────────────────────────────────────────────────────────────────────────────
router.use(authenticate);

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 1 — Match Events
// ─────────────────────────────────────────────────────────────────────────────

// Single event
router.post  ('/events',                             C.recordEvent);
router.get   ('/events/match/:matchId',              C.listEvents);
router.get   ('/events/match/:matchId/summary',      C.getEventSummary);
router.delete('/events/:id',                         C.deleteEvent);

// Bulk ingest (up to 5 000 events from a data provider feed)
router.post  ('/events/batch',                       C.batchIngestEvents);

// Transcode callback (internal — called by VideoTranscodeWorker, not user-facing)
router.post  ('/video/transcode-callback',           C.handleTranscodeCallback);

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 2 — Player Statistics
// ─────────────────────────────────────────────────────────────────────────────

// Force rebuild for a match (idempotent — safe to call repeatedly)
router.post  ('/stats/matches/:matchId/rebuild',     C.computeMatchStats);

// Per-match stats queries
router.get   ('/stats/matches/:matchId',             C.listMatchStats);
router.get   ('/stats/matches/:matchId/players/:playerId', C.getMatchStats);

// Season rollup (manual trigger — normally fired by stats-aggregator worker)
router.post  ('/stats/season-rollup',                C.rollupSeasonStats);

// Season + career read
router.get   ('/stats/players/:playerId/seasons',    C.getSeasonStats);
router.get   ('/stats/players/:playerId/profile',    C.getPlayerProfile);

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 3 — Workload & Injury
// ─────────────────────────────────────────────────────────────────────────────

// GPS session ingest
router.post  ('/workload/gps',                       C.ingestGPSSession);

// ATL/CTL/TSB recompute for a player
router.post  ('/workload/players/:playerId/recompute', C.recomputeWorkload);

// Squad readiness dashboard
router.get   ('/workload/teams/:teamId/readiness',   C.squadReadiness);

// Injuries — CRUD
router.post  ('/workload/injuries',                   C.recordInjury);
router.get   ('/workload/injuries',                   C.listInjuries);
router.get   ('/workload/injuries/:injuryId',          C.getInjury);
router.patch ('/workload/injuries/:injuryId',          C.updateInjury);
router.delete('/workload/injuries/:injuryId',          C.deleteInjury);
router.patch ('/workload/injuries/:injuryId/return',   C.updateInjuryReturn);
// Player medical profile
router.get   ('/workload/players/:playerId/medical',   C.getPlayerMedicalProfile);

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 4 — Video Intelligence
// ─────────────────────────────────────────────────────────────────────────────

// Assets
router.post  ('/video/assets/request-upload',        C.requestVideoUpload);
router.post  ('/video/assets/confirm-upload',        C.confirmVideoUpload);
router.get   ('/video/assets',                       C.listVideoAssets);
router.get   ('/video/assets/:assetId',              C.getVideoAsset);
router.get   ('/video/assets/:assetId/stream',               C.getVideoStreamUrl);
// HLS proxy — manifest + segment bytes piped through Express (auth required).
router.get   ('/video/assets/:assetId/hls/:filename',        C.streamHlsFile);
router.delete('/video/assets/:assetId',                      C.deleteVideoAsset);

// Clips
router.post  ('/video/clips',                        C.createVideoClip);
router.get   ('/video/clips',                        C.listVideoClips);
router.get   ('/video/clips/:clipId',                C.getVideoClip);
router.patch ('/video/clips/:clipId',                C.updateVideoClip);
router.delete('/video/clips/:clipId',                C.deleteVideoClip);

// Clip sharing (share token — enables unauthenticated external access)
router.post  ('/video/clips/:clipId/share',          C.shareVideoClip);
router.delete('/video/clips/:clipId/share',          C.revokeVideoShare);

// Playlists
router.post  ('/video/playlists',                    C.createVideoPlaylist);
router.get   ('/video/playlists',                    C.listVideoPlaylists);
router.get   ('/video/playlists/:playlistId',        C.getVideoPlaylist);
router.delete('/video/playlists/:playlistId',        C.deleteVideoPlaylist);
router.post  ('/video/playlists/:playlistId/clips',  C.addClipToPlaylist);
router.delete('/video/playlists/:playlistId/clips/:clipId', C.removeClipFromPlaylist);
router.put   ('/video/playlists/:playlistId/order',  C.reorderPlaylist);

// Annotations (telestration)
router.get   ('/video/clips/:clipId/annotations',    C.listAnnotations);
router.post  ('/video/annotations',                  C.createAnnotation);
router.patch ('/video/annotations/:annotationId',    C.updateAnnotation);
router.delete('/video/annotations/:annotationId',    C.deleteAnnotation);
// Bulk-replace all annotations for a clip in one save operation
router.put   ('/video/clips/:clipId/annotations',    C.replaceAnnotations);

// Video Intelligence Dashboard + per-match video summary (Phase 8)
router.get   ('/video/dashboard',                    C.getVideoDashboard);
router.get   ('/video/match/:matchId/summary',       C.getMatchVideoSummary);

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 5 — Transfer Intelligence
// ─────────────────────────────────────────────────────────────────────────────

// Scouting reports
router.post  ('/transfer/reports',                   C.createScoutingReport);
router.get   ('/transfer/reports',                   C.listScoutingReports);
router.get   ('/transfer/reports/:reportId',         C.getScoutingReport);
router.patch ('/transfer/reports/:reportId',         C.updateScoutingReport);
router.delete('/transfer/reports/:reportId',         C.deleteScoutingReport);

// Transfer pipeline
router.post  ('/transfer/targets',                   C.createTransferTarget);
router.get   ('/transfer/targets',                   C.listTransferTargets);
router.get   ('/transfer/pipeline',                  C.getPipelineBoard);
router.patch ('/transfer/targets/:targetId',         C.updateTransferTarget);
router.post  ('/transfer/targets/:targetId/advance', C.advanceTransferStage);

// Market values (append-only history)
router.post  ('/transfer/market-values',             C.recordMarketValue);
router.get   ('/transfer/market-values/squad',       C.squadValuationSummary);
router.get   ('/transfer/market-values/:playerId',   C.getMarketValueHistory);
router.get   ('/transfer/market-values/:playerId/latest', C.getLatestMarketValue);

// Contract status
router.put   ('/transfer/contracts/:playerId',       C.upsertContractStatus);
router.get   ('/transfer/contracts/:playerId',       C.getContractStatus);
router.get   ('/transfer/contracts-expiring',        C.getExpiringContracts);

// Transfer Intelligence (cross-module aggregates)
router.get   ('/transfer/intelligence/squad',                    C.getSquadTransferIntelligence);
router.get   ('/transfer/intelligence/player/:playerId',         C.getPlayerTransferIntelligence);

// Transfer Scoring Engine (Phase 10)
router.get   ('/transfer/scoring/ranked',                        C.getRankedTargets);
router.get   ('/transfer/scoring/squad-depth',                   C.getSquadDepthAnalysis);
router.post  ('/transfer/scoring/scorecard',                     C.computeSingleScorecard);

// Unified Intelligence Engine (Phase 11)
router.get   ('/transfer/intelligence/unified/:playerId',        C.getUnifiedPlayerIntelligence);
router.get   ('/transfer/intelligence/squad-summary',            C.getSquadIntelligenceSummary);
router.get   ('/transfer/intelligence/succession/:position',     C.getSuccessionCandidates);
router.get   ('/transfer/intelligence/squad-future',             C.getSquadFuturePlan);

// ─────────────────────────────────────────────────────────────────────────────
// DOMAIN 6 — Competition Engine
// ─────────────────────────────────────────────────────────────────────────────

// Competitions
router.post  ('/competitions',                       C.createCompetition);
router.get   ('/competitions',                       C.listCompetitions);
router.get   ('/competitions/:competitionId',        C.getCompetition);

// Teams in competition
router.post  ('/competitions/:competitionId/teams',  C.addTeamToCompetition);
router.get   ('/competitions/:competitionId/teams',  C.listTeamsInCompetition);
router.delete('/competitions/:competitionId/teams/:teamId', C.removeTeamFromCompetition);

// Fixtures
router.post  ('/competitions/:competitionId/fixtures',         C.createFixture);
router.get   ('/competitions/:competitionId/fixtures',         C.listFixtures);
router.patch ('/competitions/fixtures/:fixtureId',             C.updateFixture);
router.post  ('/competitions/fixtures/:fixtureId/result',      C.recordResult);
router.post  ('/competitions/fixtures/:fixtureId/cancel',      C.cancelFixture);

// Round-robin auto-generator
router.post  ('/competitions/:competitionId/fixtures/generate-round-robin', C.generateRoundRobinFixtures);

// Standings
router.get   ('/competitions/:competitionId/standings',        C.getStandings);
router.post  ('/competitions/:competitionId/standings/rebuild', C.rebuildStandings);

export default router;
