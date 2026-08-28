// Familista — Active-context routes (Phase A)
// Mounted under /api/v1/me.

import { Router } from 'express';
import * as ctrl from '../controllers/context.controller';
import * as settings from '../controllers/user-settings.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.get('/context',  ctrl.getMe);
router.post('/context', ctrl.switchMe);

// Interface language. A user preference, so it is keyed by the authenticated
// subject and carries no club — switching clubs must not change it.
router.get(  '/settings', settings.getSettings);
router.patch('/settings', settings.updateSettings);

// TEMP DIAGNOSTIC — read-only DB inspector scoped to the calling user.
// Remove once the multi-club picker bug is closed out.
router.get('/_diag',    ctrl.getDiag);

export default router;
