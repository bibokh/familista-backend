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
router.get('/approvals',    ctrl.approvals);
// Cross-club product analytics. Platform owner only, like everything here.
router.get('/analytics/platform', ctrl.platformAnalytics);
router.get('/analytics/product',  ctrl.productAnalytics);
router.get('/security',     ctrl.security);
router.get('/audit',        ctrl.audit);

// ── what the platform owner can do about it ─────────────────────────────────
// Every control below performs a real change and publishes the event that
// records it. A capability with no endpoint here is declared NOT_AVAILABLE in
// the catalogue rather than given a handler that does nothing.
// ── club onboarding ─────────────────────────────────────────────────────────
// Creating a club is a platform action and lives here, not in a club
// workspace: the platform owner never enters the club they are creating, and
// never becomes its owner. Every route below refuses club authority, like
// every other route on this router.
router.post('/clubs',                              ctrl.createClub);
router.get('/clubs/:clubId/setup',                 ctrl.clubSetup);
router.post('/clubs/:clubId/president/resend',     ctrl.resendPresidentInvite);
router.post('/clubs/:clubId/president/revoke',     ctrl.revokePresidentInvite);
router.post('/clubs/:clubId/president/replace',    ctrl.replacePresidentInvite);

router.post('/agents/kill-switch',      ctrl.killSwitch);
router.post('/flags/:key',              ctrl.setFlag);
router.post('/experiments',             ctrl.createExperiment);
router.post('/experiments/:id/decide',  ctrl.decideExperimentState);

export default router;
