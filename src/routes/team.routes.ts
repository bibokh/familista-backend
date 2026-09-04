// Familista — Team routes (Phase A)
// Mounted under /api/v1/teams. All require JWT auth.
// Mutations gated to CLUB_ADMIN/HEAD_COACH via legacy User.role,
// and additionally to active Membership via requireMembership.

import { Router } from 'express';
import * as ctrl from '../controllers/team.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { requireMembership } from '../middleware/tenant.middleware';
import { requireTeamRowAccess } from '../middleware/team-scope.middleware';

const router = Router();

router.use(authenticate);

// A team's own row is the club's shell — its name, its age group, its crest —
// and every member of the club may read it. Changing it is team control, and
// takes an assignment to manage THIS team: a First Team coach does not rename
// the Under-15s, and an Under-15 coach does not archive the First Team.
router.param('id', (req, res, next) => requireTeamRowAccess('id')(req, res, next));

router.get('/',                                                   ctrl.list);
router.get('/:id',                                                ctrl.get);
router.post('/',           authorize('CLUB_ADMIN','HEAD_COACH'), requireMembership('CLUB_ADMIN'),  ctrl.create);
router.put('/:id',         authorize('CLUB_ADMIN','HEAD_COACH'), requireMembership('CLUB_ADMIN'),  ctrl.update);
router.patch('/:id',       authorize('CLUB_ADMIN','HEAD_COACH'), requireMembership('CLUB_ADMIN'),  ctrl.update);
router.delete('/:id',      authorize('CLUB_ADMIN'),              requireMembership('CLUB_ADMIN'),  ctrl.archive);
router.post('/:id/reactivate', authorize('CLUB_ADMIN'),          requireMembership('CLUB_ADMIN'),  ctrl.reactivate);

export default router;
