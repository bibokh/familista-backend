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

// ── auctions: real bids, held by the server ─────────────────────────────────
// Reading is open to every authenticated club — an auction is public. Listing,
// bidding and cancelling are trade actions, and each one resolves the acting
// club from the session rather than the request.
router.get('/auctions',                                     ctrl.readAuctions);
router.get('/auctions/:listingId',                          ctrl.readAuction);
router.post('/auctions',                        tradeGuard, ctrl.listAuction);
router.post('/auctions/:listingId/bids',        tradeGuard, ctrl.placeBid);
router.post('/auctions/:listingId/cancel',      tradeGuard, ctrl.cancelAuction);

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
// The conversation itself, oldest offer first. Readable only by the two clubs
// in it — the service checks that before it reads anything.
router.get('/offers/:offerId/negotiation',                  ctrl.readNegotiation);

// Completed moves this club was part of, in or out.
router.get('/completed',                                    ctrl.readCompletedDeals);

// ── the market's activity ───────────────────────────────────────────────────
// The feed mixes what the market publishes with what this club is negotiating,
// and the service — not the caller — decides which events are which.
router.get('/feed',                                         ctrl.readMarketFeed);
// Where players actually went, market-wide.
router.get('/completed/market',                             ctrl.readMarketCompleted);

// ── scouting: finding a real player at another real club ────────────────────
// Discovery is a read, so every authenticated club may do it — the same tier
// that may read the market. What a result lets you DO is decided per player by
// the service, from what his own club actually did with him.
router.get('/discover',                                     ctrl.discover);
// The public view of one footballer. Deliberately NOT /players/:id, which stays
// own-club-only: this is the other question, with its own narrow projection.
router.get('/players/:playerId',                            ctrl.readPublicPlayer);

// ── contract renewal: keeping him, which is the fourth answer to selling ─────
// Reading his terms and rewriting them are both own-club actions, so both sit
// behind the same trade tier as listing him. The service resolves the acting
// club from the session and refuses a player another club owns. It asks nothing
// about which team he is in: the First Team and every age group renew here.
router.get('/players/:playerId/contract',        tradeGuard, ctrl.readPlayerContract);
router.post('/players/:playerId/contract/renew', tradeGuard, ctrl.renewPlayerContract);

// ── the club's own transfer desk ────────────────────────────────────────────
// One read replacing four. Scoped to the caller inside the service, so it can
// only ever describe the club whose session asked.
router.get('/my-club',                                      ctrl.readMyClub);

// ── shortlist: the club's own TransferTarget pipeline ───────────────────────
// Club-scoped inside the service on every call, so one club can neither read
// nor change another's list.
router.get('/shortlist',                                    ctrl.readShortlist);
router.post('/shortlist',                       tradeGuard, ctrl.addToShortlist);
router.delete('/shortlist/:playerId',           tradeGuard, ctrl.removeFromShortlist);

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
// Answering a published need with a player this club owns.
router.post('/offer-to-need',                   tradeGuard, ctrl.offerPlayerToNeed);

export default router;
