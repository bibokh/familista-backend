// Familista — Club System routes (Phase R)
// Mounted at /api/v1/clubs
//
// POST  /clubs              — onboard a new club (PLATFORM OWNER only; the
//                             caller becomes CLUB_OWNER of the new club, which
//                             is exactly why it cannot be open to everybody)
// GET   /clubs/current      — caller's active club (read; any authenticated member)
// GET   /clubs/:clubId      — club profile (tenant-guarded)
// PATCH /clubs/:clubId      — update club + brand (CLUB_ADMIN / SUPER_ADMIN, tenant-guarded)

import { Router } from 'express';
import { UserRole } from '@prisma/client';
import * as ctrl from '../controllers/club.controller';
import { authenticate, authorize, ensureClubAccess } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

// The platform-owner check is in the controller rather than a route guard: it
// is the same assertPlatformOwner every SYSTEM route uses, and putting it
// beside the write keeps the two from drifting apart.
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
