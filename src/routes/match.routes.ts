// Familista — Match routes (Phase B)
// All routes require JWT auth. Writes are role-gated via authorize()
// AND tenant-isolated by the service layer (assertMatchInClub).

import { Router } from 'express';
import * as ctrl   from '../controllers/match.controller';
import * as mi     from '../controllers/match-intelligence.controller';
import * as fusion from '../controllers/fusion.controller';
import * as rt     from '../controllers/realtime.controller';
import * as ai     from '../controllers/ai-ops.controller';
import * as si     from '../controllers/sensor-ingest.controller';
import * as ann    from '../controllers/annotation.controller';
import { matchLiveSse } from '../realtime/match-sse';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// SSE handles its own auth (supports ?token= because EventSource cannot
// set Authorization headers). Registered BEFORE `router.use(authenticate)`
// so the standard middleware doesn't reject browser clients.
router.get('/:id/live', matchLiveSse);

router.use(authenticate);

// ── Match CRUD ───────────────────────────────────────────────────────────
router.get('/',              ctrl.getMatches);
router.get('/results',       ctrl.getResults);
router.post('/',             authorize('CLUB_ADMIN','HEAD_COACH'),            ctrl.createMatch);
router.get('/:id',           ctrl.getMatch);
router.put('/:id',           authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'),  ctrl.updateMatch);
router.patch('/:id',         authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'),  ctrl.updateMatch);
router.delete('/:id',        authorize('CLUB_ADMIN'),                         ctrl.deleteMatch);

// ── Live-state transitions ───────────────────────────────────────────────
router.post('/:id/live/start',     authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.startLive);
router.post('/:id/live/halftime',  authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.setHalftime);
router.post('/:id/live/resume',    authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.resumeSecondHalf);
router.post('/:id/live/finalize',  authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'), ctrl.finalize);
router.post('/:id/live/abandon',   authorize('CLUB_ADMIN','HEAD_COACH'),           ctrl.abandon);

// ── Lineups ──────────────────────────────────────────────────────────────
router.get('/:id/lineups',  mi.getLineups);
router.put('/:id/lineups',  authorize('CLUB_ADMIN','HEAD_COACH','ASSISTANT_COACH','ANALYST'), mi.setLineup);

// ── Timeline (live human-entered events) ─────────────────────────────────
router.get('/:id/timeline',                       mi.listTimeline);
router.post('/:id/timeline',                      authorize('CLUB_ADMIN','HEAD_COACH','ASSISTANT_COACH','ANALYST'), mi.addTimeline);
router.patch('/:id/timeline/:eventId',            authorize('CLUB_ADMIN','HEAD_COACH','ASSISTANT_COACH','ANALYST'), mi.editTimeline);
router.delete('/:id/timeline/:eventId',           authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'),                   mi.deleteTimeline);

// ── Tactical snapshots ───────────────────────────────────────────────────
router.get('/:id/tactical',                       mi.listSnapshots);
router.post('/:id/tactical',                      authorize('CLUB_ADMIN','HEAD_COACH','ASSISTANT_COACH','ANALYST'), mi.takeSnapshot);

// ── AI feature bundle + audit ────────────────────────────────────────────
router.get('/:id/ai-features', mi.getFeatureBundle);
router.get('/:id/audit',       authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.listAudit);

// ── Cognitive Sensor-to-Vision Fusion Frame (Phase D-IP, read-only) ──────
router.get('/:id/fusion',      fusion.getFusionFrame);

// ── Phase E · Live Tactical Digital Twin + AI Ops ────────────────────────
// REST polling cousin of /:id/live (SSE).
router.get('/:id/tactical-state', rt.getTacticalState);

// Phase F · Match Brain — tactical state + event graph + momentum + pressure zones.
router.get('/:id/brain',          rt.getMatchBrain);

// Replay timeline — chronological join over timeline/snapshots/alerts/frames.
router.get('/:id/replay',          rt.getReplay);

// Trigger deterministic rules engine on demand (also runs async on writes).
router.post('/:id/rules/evaluate', authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','ASSISTANT_COACH'), rt.triggerRulesEvaluation);

// Match-scoped alert/recommendation reads — convenience wrappers around
// the global /ai-ops endpoints (server enforces matchId filter on the
// caller's clubId).
router.get('/:id/alerts',          ai.listAlerts);
router.get('/:id/recommendations', ai.listRecommendations);
router.get('/:id/reports',         ai.listReports);

// Sensor packet aliases — accept packets WITHOUT a deviceSession (resolves
// the active matchId-scoped session server-side). Convenience for the
// Live tab + opaque ingestion bridges.
router.post('/:id/sensor-packet',  authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','ASSISTANT_COACH','MEDICAL_STAFF'), si.ingestMatchSensorPacket);
router.post('/:id/fusion-packet',  authorize('CLUB_ADMIN','HEAD_COACH','ANALYST','ASSISTANT_COACH','MEDICAL_STAFF'), si.ingestMatchFusionPacket);

// ── Phase G · Coach tactical annotations ─────────────────────────────────
// Match-scoped read+write. Tenant gate is enforced in annotation.service.
router.get('/:id/annotations',                          ann.list);
router.post('/:id/annotations',                         authorize('CLUB_ADMIN','HEAD_COACH','ASSISTANT_COACH','ANALYST'), ann.create);
router.patch('/:id/annotations/:annotationId',          authorize('CLUB_ADMIN','HEAD_COACH','ASSISTANT_COACH','ANALYST'), ann.update);
router.delete('/:id/annotations/:annotationId',         authorize('CLUB_ADMIN','HEAD_COACH','ANALYST'),                   ann.remove);

export default router;
