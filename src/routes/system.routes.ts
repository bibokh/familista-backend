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

// ── what the platform knows ─────────────────────────────────────────────────
router.get('/whoami',       ctrl.whoAmI);
router.get('/modules',      ctrl.modules);
router.get('/overview',     ctrl.overview);
router.get('/clubs',        ctrl.clubs);
router.get('/people',       ctrl.people);
router.get('/signals',      ctrl.signals);
router.get('/capabilities', ctrl.capabilities);
router.get('/intelligence', ctrl.intelligence);
router.get('/innovation',   ctrl.innovation);
router.get('/governance',   ctrl.governance);
router.get('/security',     ctrl.security);
router.get('/audit',        ctrl.audit);

// ── what the platform owner can do about it ─────────────────────────────────
// Every control below performs a real change and publishes the event that
// records it. A capability with no endpoint here is declared NOT_AVAILABLE in
// the catalogue rather than given a handler that does nothing.
router.post('/agents/kill-switch',      ctrl.killSwitch);
router.post('/flags/:key',              ctrl.setFlag);
router.post('/experiments',             ctrl.createExperiment);
router.post('/experiments/:id/decide',  ctrl.decideExperimentState);

export default router;
