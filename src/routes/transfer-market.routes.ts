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

const TRADE_ROLES = ['CLUB_ADMIN', 'HEAD_COACH'] as const;
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

export default router;
