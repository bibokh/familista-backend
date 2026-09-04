// Familista — Player routes (Phase 2)
// Mounted under /api/v1/players. Every route requires JWT auth; mutations
// require role authorization. Soft-delete is the default; hard delete is
// gated to CLUB_ADMIN only.

import { Router } from 'express';
import * as ctrl from '../controllers/player.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { requirePlayerTeamAccess } from '../middleware/team-scope.middleware';

const router = Router();

router.use(authenticate);

// A player belongs to a team, and his record is that team's private content:
// his profile, his attributes, his statistics, his attendance, his medical
// availability. Every route addressed by :id passes through this before its
// handler runs — reading takes private sight of his team, changing him takes an
// assignment to manage it — so a player id typed into a URL by somebody who
// works on another of the club's teams is refused with a 403 rather than
// answered. Registered as a param handler so it cannot be forgotten on a route
// added later, and so the static paths (/performance/squad) are untouched.
router.param('id', (req, res, next) => requirePlayerTeamAccess('id')(req, res, next));

// ── Reads (every authenticated user can list / view) ─────────────────────
router.get('/',               ctrl.getPlayers);
router.get('/:id',            ctrl.getPlayer);
router.get('/:id/stats',      ctrl.getPlayerStats);
router.get('/:id/attendance', ctrl.getPlayerAttendance);
router.get('/:id/audit',      authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.getPlayerAudit);

// ── Writes ───────────────────────────────────────────────────────────────
router.post('/',                authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.createPlayer);
router.put('/:id',              authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.updatePlayer);
router.patch('/:id',            authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.updatePlayer);

// DELETE = soft-delete (sets isActive=false, audited).
router.delete('/:id',           authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.deletePlayer);
// Reactivate a soft-deleted player.
router.post('/:id/reactivate',  authorize('CLUB_ADMIN','HEAD_COACH'), ctrl.reactivatePlayer);
// Permanent removal — admins only.
router.delete('/:id/hard',      authorize('CLUB_ADMIN'),              ctrl.deletePlayerHard);

// ── GPS + AI (existing) ──────────────────────────────────────────────────
router.post('/:id/gps',         ctrl.addGpsData);
router.post('/:id/ai-analysis', ctrl.analyzePlayer);

// ── Performance / Attributes ─────────────────────────────────────────────
// IMPORTANT: /performance/squad must be registered before /:id to prevent
// Express matching "performance" as a dynamic :id segment.
router.get('/performance/squad',  ctrl.getSquadPerformance);
router.post('/:id/attributes',    authorize('CLUB_ADMIN', 'HEAD_COACH'), ctrl.recordAttributes);
router.get('/:id/attributes',     ctrl.getAttributeHistory);

export default router;
