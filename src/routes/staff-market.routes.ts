// Familista — coaches & technical staff market routes
// ─────────────────────────────────────────────────────────────────────────────
// Reading the market is open to any authenticated club, exactly as the player
// market is: knowing who is available is not the same as being able to hire
// them. Everything that commits a club — an approach, a counter, an acceptance,
// a need, a record edit — is a recruitment action and takes the same
// club-operator tier the transfer routes use.

import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import * as ctrl from '../controllers/staff-market.controller';

const router = Router();
router.use(authenticate);

const RECRUIT_ROLES = ['SUPER_ADMIN', 'CLUB_ADMIN', 'MANAGER', 'HEAD_COACH'] as const;
const recruitGuard = authorize(...RECRUIT_ROLES);

// ── the market ──────────────────────────────────────────────────────────────
router.get('/summary',                 ctrl.summary);
router.get('/discover',                ctrl.discover);
// Every club on the platform, so the filters populate themselves. Nothing in
// this module carries a list of clubs.
router.get('/clubs',                   ctrl.clubs);
router.get('/staff/:staffUserId',      ctrl.readStaff);

// Side by side, from the same projection a profile is read with.
router.get('/compare',                 ctrl.compare);

// ── this club's desk ────────────────────────────────────────────────────────
router.get('/my-staff',                ctrl.myStaff);
router.get('/activity',                ctrl.activity);

// ── the shortlist ───────────────────────────────────────────────────────────
// The club's own watchlist. Reading it is reading this club's desk; changing it
// is a recruitment action.
router.get('/shortlist',                      ctrl.readShortlist);
// What this club has written about somebody. Private to it.
router.put('/notes/:staffUserId',             recruitGuard, ctrl.saveClubNote);
router.put('/shortlist/:staffUserId',         recruitGuard, ctrl.addToShortlist);
router.patch('/shortlist/:staffUserId',       recruitGuard, ctrl.setShortlistMeta);
router.delete('/shortlist/:staffUserId',      recruitGuard, ctrl.removeFromShortlist);

// ── needs ───────────────────────────────────────────────────────────────────
router.get('/needs',                   ctrl.readNeeds);
router.post('/needs',                  recruitGuard, ctrl.createNeed);
router.delete('/needs/:needId',        recruitGuard, ctrl.closeNeed);

// ── recruitment ─────────────────────────────────────────────────────────────
router.post('/approaches',                       recruitGuard, ctrl.approach);
router.get('/approaches/:approachId',            ctrl.readApproach);
router.post('/approaches/:approachId/counter',   recruitGuard, ctrl.counter);
router.post('/approaches/:approachId/accept',    recruitGuard, ctrl.accept);
router.post('/approaches/:approachId/reject',    recruitGuard, ctrl.reject);
router.post('/approaches/:approachId/withdraw',  recruitGuard, ctrl.withdraw);
router.post('/approaches/:approachId/viewed',    ctrl.markViewed);
router.post('/approaches/:approachId/interview', recruitGuard, ctrl.invite);

// ── keeping the record ──────────────────────────────────────────────────────
// A club completes what it knows about its own staff. Nothing here invents a
// licence, a trophy or a season.
router.patch('/staff/:staffUserId',    recruitGuard, ctrl.upsertProfile);
// Gives a club's existing technical staff their professional record, from the
// memberships the platform already holds. Idempotent.
router.post('/bootstrap',              recruitGuard, ctrl.bootstrapStaff);
// A candidate the platform does not employ anywhere. One User, one profile, no
// membership — which is what a free agent is here.
router.post('/external',               recruitGuard, ctrl.addExternal);

export default router;
