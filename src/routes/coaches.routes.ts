// Familista — the current technical staff directory
// ─────────────────────────────────────────────────────────────────────────────
// Its own module and its own route. It is not the staff market and it is not a
// view of it: this answers "who is working where, right now", read from the
// teams and memberships the platform already holds.
//
// It shares one thing with the market, deliberately — the person. The same
// canonical staff profile is opened from either, because a coach is one person
// with one record whichever screen he is looked at from.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import * as ctrl from '../controllers/coaches.controller';

const router = Router();
router.use(authenticate);

// Every current team and its technical staff. Reading, so any authenticated
// club may do it — the same tier that may read the market.
router.get('/directory', ctrl.directory);

export default router;
