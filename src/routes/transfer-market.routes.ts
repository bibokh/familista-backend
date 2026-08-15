// Familista — club-to-club transfer market routes
// ─────────────────────────────────────────────────────────────────────────────
// Visibility and mutation are deliberately different routes with different
// guards: any authenticated club may READ the market, only the owning club may
// list or delist, and only a club that does not own the listing may buy it.

import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import * as ctrl from '../controllers/transfer-market.controller';

const router = Router();
router.use(authenticate);

// Who may trade on a club's behalf. This is the club-operator tier the rest of
// the codebase already uses for club administration — the owner included.
// SUPER_ADMIN was missing here, so the account that owns the platform was the
// one account that could not lift its own club's roster: bootstrap answered 403
// and the squad fell back to the browser's copy. MANAGER runs a club's football
// side in the same guards elsewhere and belongs with them.
// Everyone else stays out: ANALYST, SCOUT, MEDICAL_STAFF, ASSISTANT_COACH,
// COACH, PARENT and PLAYER cannot list, delist, bootstrap or buy.
const TRADE_ROLES = ['SUPER_ADMIN', 'CLUB_ADMIN', 'MANAGER', 'HEAD_COACH'] as const;
const tradeGuard = authorize(...TRADE_ROLES);

// ── read: every authenticated club sees other clubs' active listings ─────────
router.get('/market',       ctrl.readMarket);
router.get('/my-listings',  ctrl.readOwnListings);
router.get('/balance',      ctrl.getBalance);

// ── write: owner-only ────────────────────────────────────────────────────────
router.post('/listings',              tradeGuard, ctrl.listPlayer);
router.delete('/listings/:listingId', tradeGuard, ctrl.delistPlayer);

// ── bootstrap: lift a club's current roster into real Player rows, once ──────
router.post('/bootstrap', tradeGuard, ctrl.bootstrapRoster);

// ── settlement: buyer-only, atomic, idempotent ───────────────────────────────
router.post('/listings/:listingId/purchase', tradeGuard, ctrl.purchase);

// ── club-to-club negotiation ────────────────────────────────────────────────
// Reading is scoped inside the service to the club's own side of things, so a
// club can only ever see negotiations it is part of. Writing is a trade action.
router.post('/interest',                        tradeGuard, ctrl.registerInterest);
router.patch('/interest/:interestId',           tradeGuard, ctrl.respondToInterest);

router.post('/offers',                          tradeGuard, ctrl.makeOffer);
router.get('/offers/activity',                              ctrl.readActivity);
router.get('/offers/player/:playerId',                      ctrl.readOffersForPlayer);
router.get('/offers/:offerId',                              ctrl.readOffer);
router.post('/offers/:offerId/accept',          tradeGuard, ctrl.acceptOffer);
router.post('/offers/:offerId/reject',          tradeGuard, ctrl.rejectOffer);
router.post('/offers/:offerId/withdraw',        tradeGuard, ctrl.withdrawOffer);
router.post('/offers/:offerId/counter',         tradeGuard, ctrl.counterOffer);

// ── recruitment needs: a club publishes what it is looking for ──────────────
router.get('/needs',                                        ctrl.readMarketNeeds);
router.get('/needs/mine',                                   ctrl.readOwnNeeds);
router.post('/needs',                           tradeGuard, ctrl.createNeed);
router.patch('/needs/:needId',                  tradeGuard, ctrl.updateNeed);
router.delete('/needs/:needId',                 tradeGuard, ctrl.deleteNeed);

// ── matching, and the owner taking his player to a club that wants one ──────
router.get('/matches/:playerId',                            ctrl.matchesForPlayer);
// The mirror: the clubs' needs are public, so any club may ask which of ITS
// OWN players fit one. The squad scored is always the caller's.
router.get('/needs/:needId/matches',                        ctrl.matchesForNeed);
router.post('/offer-to-clubs',                  tradeGuard, ctrl.offerPlayerToClubs);

export default router;
