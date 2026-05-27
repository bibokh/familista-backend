// Familista — Player routes (Phase 2)
// Mounted under /api/v1/players. Every route requires JWT auth; mutations
// require role authorization. Soft-delete is the default; hard delete is
// gated to CLUB_ADMIN only.

import { Router } from 'express';
import * as ctrl from '../controllers/player.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

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
