import { Router } from 'express';
import * as ctrl from '../controllers/scouting.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// All scouting routes require authentication
router.use(authenticate);

const SCOUT_ROLES = ['CLUB_ADMIN', 'HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST', 'SCOUT'] as const;
const writeGuard = authorize(...SCOUT_ROLES);

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard', ctrl.getScoutDashboard);

// ── Pipeline board ────────────────────────────────────────────────────────────
router.get('/pipeline', ctrl.getPipelineBoard);

// ── Watchlist ─────────────────────────────────────────────────────────────────
router.get('/watchlist', ctrl.getWatchlist);

// ── Comparison engine ─────────────────────────────────────────────────────────
// GET /scouting/compare?prospectA=<uuid>&prospectB=<uuid>
router.get('/compare', ctrl.compareProspects);

// ── Prospects CRUD ────────────────────────────────────────────────────────────
router.get('/',    ctrl.listProspects);
router.post('/',   writeGuard, ctrl.createProspect);

router.get(   '/:prospectId', ctrl.getProspect);
router.patch( '/:prospectId', writeGuard, ctrl.updateProspect);
router.delete('/:prospectId', writeGuard, ctrl.deleteProspect);

// ── Pipeline status update ────────────────────────────────────────────────────
router.patch('/:prospectId/pipeline', writeGuard, ctrl.advancePipelineStatus);

// ── Watchlist toggle ──────────────────────────────────────────────────────────
router.patch('/:prospectId/watchlist', writeGuard, ctrl.updateWatchlist);

export default router;
