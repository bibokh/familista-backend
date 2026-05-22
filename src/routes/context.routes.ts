// Familista — Active-context routes (Phase A)
// Mounted under /api/v1/me.

import { Router } from 'express';
import * as ctrl from '../controllers/context.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.get('/context',  ctrl.getMe);
router.post('/context', ctrl.switchMe);

export default router;
