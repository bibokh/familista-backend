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
router.get('/email',        ctrl.email);
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

// ── club lifecycle ──────────────────────────────────────────────────────────
// Suspending, archiving and restoring a club are the platform's decisions, and
// this router is the only place they can be made. A club's own president holds
// no route to any of them, whatever their membership says — which is the point
// of putting them here rather than under /clubs.
//
// Deactivate and archive DELETE NOTHING. They move one enum on one row, and
// every player, team, membership, match, session, transfer and record the club
// owns stays exactly where it is. Reactivate and restore put the club back into
// the state it left, which is recorded when it leaves.
router.get('/clubs/:clubId/lifecycle',          ctrl.clubLifecycle);
router.get('/clubs/:clubId/lifecycle/history',  ctrl.clubLifecycleHistory);
router.post('/clubs/:clubId/deactivate',        ctrl.deactivateClub);
router.post('/clubs/:clubId/reactivate',        ctrl.reactivateClub);
router.post('/clubs/:clubId/archive',           ctrl.archiveClub);
router.post('/clubs/:clubId/restore',           ctrl.restoreClub);

// What permanent deletion would destroy, and permanent deletion itself. The
// preview is a separate GET on purpose: the dialog that asks somebody to
// confirm an irreversible act reads it first, so what is confirmed is a list of
// real records rather than a warning in the abstract.
router.get('/clubs/:clubId/dependencies',       ctrl.clubDependencies);
router.delete('/clubs/:clubId',                 ctrl.deleteClubForever);

router.post('/agents/kill-switch',      ctrl.killSwitch);
router.post('/flags/:key',              ctrl.setFlag);
router.post('/experiments',             ctrl.createExperiment);
router.post('/experiments/:id/decide',  ctrl.decideExperimentState);

export default router;
