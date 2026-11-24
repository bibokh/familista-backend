/**
 * Familista Manufacturing (M4) — the Platform Owner's console, owner-brokered.
 *
 * Mounted at /system/manufacturing. Every handler is behind authenticate and assertPlatformOwner, enforced here on the
 * server before any handler runs; the Owner's requests run on the named system path (auth.middleware.ts), which is how
 * the Owner reaches every club's requests. Never cached.
 *
 *   suppliers   the factories the Owner works with: recorded as prospects, verified with a note of what was checked,
 *               suspended. Platform data; no supplier logs in (the Supplier Portal comes later, on its own workspaces).
 *   requests    every club's requests for quotation: review or refuse; record the quotations real suppliers give, as
 *               drafts, and publish them to the club (a verified supplier's only, which the database holds too);
 *               withdraw one; confirm the order once settled with the supplier outside the platform; record production,
 *               shipping and delivery; read a design exactly as the request froze it, for production.
 *
 * Nothing here charges, pays or contacts anyone.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import {
  ownerConfirmOrder, ownerCreateSupplier, ownerDiscardDraft, ownerListRequests, ownerListSuppliers, ownerOpenRequest, ownerOpenSupplier,
  ownerPublishQuote, ownerRecordDelivery, ownerRecordQuote, ownerRecordShipping, ownerRefuseRequest, ownerReviewRequest, ownerSaveSupplier,
  ownerSetSupplierStatus, ownerSpecDesign, ownerStartProduction, ownerWithdrawQuote,
} from '../platform/manufacturing/owner-http';

const router = Router();
router.use(authenticate);
router.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const u = req.user;
    await assertPlatformOwner({ userId: u?.id ?? '', clubId: u?.clubId ?? null, role: u?.role });
    res.setHeader('Cache-Control', 'no-store');
    next();
  } catch (err) { next(err); }
});

router.get('/suppliers', ownerListSuppliers);
router.post('/suppliers', ownerCreateSupplier);
router.get('/suppliers/:supplierId', ownerOpenSupplier);
router.put('/suppliers/:supplierId', ownerSaveSupplier);
router.post('/suppliers/:supplierId/status', ownerSetSupplierStatus);

router.get('/requests', ownerListRequests);
router.get('/requests/:requestId', ownerOpenRequest);
router.post('/requests/:requestId/review', ownerReviewRequest);
router.post('/requests/:requestId/refuse', ownerRefuseRequest);
router.post('/requests/:requestId/quotes', ownerRecordQuote);
router.post('/requests/:requestId/quotes/:quoteId/publish', ownerPublishQuote);
router.post('/requests/:requestId/quotes/:quoteId/withdraw', ownerWithdrawQuote);
router.delete('/requests/:requestId/quotes/:quoteId', ownerDiscardDraft);
router.post('/requests/:requestId/order', ownerConfirmOrder);
router.post('/requests/:requestId/production', ownerStartProduction);
router.post('/requests/:requestId/shipped', ownerRecordShipping);
router.post('/requests/:requestId/delivered', ownerRecordDelivery);
router.get('/requests/:requestId/designs/:projectId', ownerSpecDesign);

export default router;
