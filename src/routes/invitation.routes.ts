// Club invitations
// ─────────────────────────────────────────────────────────────────────────────
// Two audiences on one router, and the split is deliberate.
//
//   · the club — create, list, resend, revoke. Club administration, so the
//     existing club-admin gates apply and the club is the session's, never the
//     request's.
//   · the recipient — preview and accept. Preview takes no session at all,
//     because the person following the link may not have an account yet; it
//     answers only what the link is for. Accept takes a session, and the
//     signed-in account's email must be the invited one.
//
// Nothing here reads, sets or returns a password. Somebody accepting an
// invitation signs in with credentials only they know, or registers through the
// ordinary auth route first.

import { Router } from 'express';
import * as ctrl from '../controllers/invitation.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { requireMembership } from '../middleware/tenant.middleware';

const router = Router();

// ── the recipient's side, before there is a session ─────────────────────────
router.get('/preview', ctrl.preview);

// ── everything else needs one ───────────────────────────────────────────────
router.use(authenticate);

router.post('/accept', ctrl.accept);

router.get('/',            authorize('CLUB_ADMIN', 'SUPER_ADMIN'), requireMembership('CLUB_ADMIN'), ctrl.list);
router.post('/',           authorize('CLUB_ADMIN', 'SUPER_ADMIN'), requireMembership('CLUB_ADMIN'), ctrl.create);
router.post('/:id/resend', authorize('CLUB_ADMIN', 'SUPER_ADMIN'), requireMembership('CLUB_ADMIN'), ctrl.resend);
router.delete('/:id',      authorize('CLUB_ADMIN', 'SUPER_ADMIN'), requireMembership('CLUB_ADMIN'), ctrl.revoke);

export default router;
