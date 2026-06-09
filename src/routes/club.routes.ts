// Familista — Club System routes (Phase R)
// Mounted at /api/v1/clubs
//
// POST  /clubs              — onboard a new club (any authenticated user;
//                             caller becomes CLUB_OWNER of the new club)
// GET   /clubs/current      — caller's active club (read; any authenticated member)
// GET   /clubs/:clubId      — club profile (tenant-guarded)
// PATCH /clubs/:clubId      — update club + brand (CLUB_ADMIN / SUPER_ADMIN, tenant-guarded)

import { Router } from 'express';
import { UserRole } from '@prisma/client';
import * as ctrl from '../controllers/club.controller';
import { authenticate, authorize, ensureClubAccess } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.post('/',       ctrl.createClub);
router.get('/current', ctrl.getCurrentClub);
router.get('/:clubId', ensureClubAccess, ctrl.getClub);
router.patch(
  '/:clubId',
  authorize(UserRole.CLUB_ADMIN, UserRole.SUPER_ADMIN),
  ensureClubAccess,
  ctrl.updateClub,
);

export default router;
