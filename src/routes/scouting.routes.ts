import { Router } from 'express';
import * as ctrl from '../controllers/scouting.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { guardTeamScopedRouter } from '../middleware/team-scope.middleware';

const router = Router();

// All scouting routes require authentication
router.use(authenticate);

// Team scope, on every route of this router that names a team, a player or a
// match. Scouting reads a club's players; a named team narrows it to that team.
// Club membership opens the club's shell; working on the team opens what is
// inside it. Enforced by the same access service the Squad, Training, the
// Match Center and the Familista League already use — reading takes private
// sight of the team, writing takes an assignment to manage it, and a team,
// player or match id from another team or another club is refused with 403
// before the handler runs.
guardTeamScopedRouter(router);

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
