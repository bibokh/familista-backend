// Familista — Home Dashboard routes
// Mounted at /api/v1/home

import { Router } from 'express';
import * as ctrl from '../controllers/home.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.get('/dashboard', ctrl.getDashboard);

export default router;
