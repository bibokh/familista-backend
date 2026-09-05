// SYSTEM / FOS
// ─────────────────────────────────────────────────────────────────────────────
// The platform's own operating surface, mounted at /api/v1/system and nowhere
// near a club. Every route is the platform owner's; a club owner reaches none
// of it, whatever their club role says, because owning a club is not owning
// Familista.
//
// The one exception is /whoami, which answers what the CALLER is — platform
// owner, club owner, club staff or viewer — because a shell has to know which
// product to draw before it can ask for anything.

import { Router } from 'express';
import * as ctrl from '../controllers/system.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();
router.use(authenticate);

router.get('/whoami',   ctrl.whoAmI);
router.get('/modules',  ctrl.modules);
router.get('/overview', ctrl.overview);
router.get('/clubs',    ctrl.clubs);
router.get('/people',   ctrl.people);

export default router;
