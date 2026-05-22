// Familista — Membership routes (Phase A)
// Mounted under /api/v1/memberships. Read: any active club member.
// Write: CLUB_ADMIN/CLUB_OWNER via legacy role AND active club membership.

import { Router } from 'express';
import * as ctrl from '../controllers/membership.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { requireMembership } from '../middleware/tenant.middleware';

const router = Router();

router.use(authenticate);

router.get('/',                ctrl.list);
router.get('/audit',           authorize('CLUB_ADMIN','HEAD_COACH'), requireMembership('CLUB_ADMIN'), ctrl.listAudit);
router.post('/',               authorize('CLUB_ADMIN'),              requireMembership('CLUB_ADMIN'), ctrl.grant);
router.patch('/:id/role',      authorize('CLUB_ADMIN'),              requireMembership('CLUB_ADMIN'), ctrl.changeRole);
router.delete('/:id',          authorize('CLUB_ADMIN'),              requireMembership('CLUB_ADMIN'), ctrl.revoke);

export default router;
