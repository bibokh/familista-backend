// Familista — Team routes (Phase A)
// Mounted under /api/v1/teams. All require JWT auth.
// Mutations gated to CLUB_ADMIN/HEAD_COACH via legacy User.role,
// and additionally to active Membership via requireMembership.

import { Router } from 'express';
import * as ctrl from '../controllers/team.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { requireMembership } from '../middleware/tenant.middleware';

const router = Router();

router.use(authenticate);

router.get('/',                                                   ctrl.list);
router.get('/:id',                                                ctrl.get);
router.post('/',           authorize('CLUB_ADMIN','HEAD_COACH'), requireMembership('CLUB_ADMIN'),  ctrl.create);
router.put('/:id',         authorize('CLUB_ADMIN','HEAD_COACH'), requireMembership('CLUB_ADMIN'),  ctrl.update);
router.patch('/:id',       authorize('CLUB_ADMIN','HEAD_COACH'), requireMembership('CLUB_ADMIN'),  ctrl.update);
router.delete('/:id',      authorize('CLUB_ADMIN'),              requireMembership('CLUB_ADMIN'),  ctrl.archive);
router.post('/:id/reactivate', authorize('CLUB_ADMIN'),          requireMembership('CLUB_ADMIN'),  ctrl.reactivate);

export default router;
