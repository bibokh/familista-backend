/**
 * Familista Creator Studio (P2) — a signed-in creator's own account and records, mounted at /creator (its way in is
 * creator-auth.routes.ts, mounted before this at /creator/auth).
 *
 * Every handler is behind authenticateCreator: a token of the creator audience (never a club session), a live account,
 * the token's current version. The request runs in the creator's own database context, so row-level security answers
 * it with that creator's rows and nothing of any club's; its design scope is PERSONAL. No request names its owner.
 *
 * The design, brand-kit, roster, collection, review and quotation handlers are the club's own (src/platform/...-http.ts):
 * they take the tenant the scope names, so only the gate differs. Every id a path names is checked against the creator
 * before its handler runs (router.param + creatorOwns); the services filter by the creator too, and the database holds
 * each child to its parent's owner (composite keys) and each row to its owner (row-level security).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { authenticateCreator } from '../platform/creator/authenticate';
import { creatorOwns, creatorSharedWith, requireVerifiedEmail } from '../platform/creator/guard';
import {
  creatorBilling, creatorGettingStarted, creatorCancelPlan, creatorCheckout, creatorFeature, creatorLimit, creatorProExport, creatorRequestPlan, creatorTechPack,
} from '../platform/commercial/http';
import {
  commentOnSharedDesign, createProjectShare, listProjectShares, listSharedWithMe, openSharedDesign, readSharedReview, revokeProjectShare,
} from '../platform/creator/share-http';
import { creatorChangePassword, creatorDeleteAccount, creatorExport, creatorMe, creatorResendVerification, creatorUpdateProfile } from '../platform/creator/http';
import {
  archiveDesign, createDesign, listDesignRevisions, listDesigns, openDesign, openDesignRevision, restoreDesignRevision, saveDesign, unarchiveDesign,
} from '../platform/product-design/http';
import {
  archiveBrandAsset, brandAssetImage, rawBrandImage, readBrandKit, saveBrandColours, unarchiveBrandAsset, uploadBrandAsset,
} from '../platform/product-design/brand-http';
import {
  archiveTeamRoster, createTeamRoster, deleteTeamRoster, listTeamRosters, openTeamRoster, saveTeamRoster, unarchiveTeamRoster,
} from '../platform/product-design/roster-http';
import {
  archiveDesignCollection, createDesignCollection, deleteDesignCollection, listDesignCollections, openDesignCollection, readOrderSheet,
  saveDesignCollection, unarchiveDesignCollection,
} from '../platform/product-design/collection-http';
import {
  acceptManufacturingQuote, cancelManufacturingRequest, confirmManufacturingDelivery, declineManufacturingQuotes, listManufacturingRequests,
  openManufacturingRequest, submitManufacturingRequest,
} from '../platform/manufacturing/club-http';
import { commentOnDesign, decideOnDesign, readDesignReview, reopenDesignComment, resolveDesignComment } from '../platform/product-design/review-http';

const router = Router();
router.use(authenticateCreator);
router.use((_req: Request, res: Response, next: NextFunction) => { res.setHeader('Cache-Control', 'no-store'); next(); });
router.param('id', creatorOwns('designProject'));
router.param('commentId', creatorOwns('designReviewComment'));
router.param('assetId', creatorOwns('designBrandAsset'));
router.param('rosterId', creatorOwns('designRoster'));
router.param('collectionId', creatorOwns('designCollection'));
router.param('requestId', creatorOwns('manufacturingRequest'));
router.param('quoteId', creatorOwns('manufacturingQuote'));
router.param('shareId', creatorOwns('designShare'));
router.param('sharedProjectId', creatorSharedWith);
router.param('invoiceId', creatorOwns('commercialInvoice'));

// The account.
router.get('/me', creatorMe);
router.patch('/me', creatorUpdateProfile);
router.post('/me/password', creatorChangePassword);
router.post('/me/verification', creatorResendVerification);
// The account's own data: a copy of all of it, and deleting the account (with the password).
router.get('/me/export', creatorExport);
router.post('/me/delete', creatorDeleteAccount);

// The creator's designs and their versions.
router.get('/projects', listDesigns);
router.post('/projects', creatorLimit('projects'), createDesign);
router.get('/projects/:id', openDesign);
router.post('/projects/:id/revisions', saveDesign);
router.get('/projects/:id/revisions', listDesignRevisions);
router.get('/projects/:id/revisions/:number', openDesignRevision);
router.post('/projects/:id/revisions/:number/restore', restoreDesignRevision);
router.post('/projects/:id/archive', archiveDesign);
router.post('/projects/:id/unarchive', unarchiveDesign);

// Review notes and the creator's own approval of a version (P4 adds collaborators).
router.get('/projects/:id/review', creatorFeature('reviews'), readDesignReview);
router.post('/projects/:id/comments', creatorFeature('reviews'), commentOnDesign);
router.post('/projects/:id/comments/:commentId/resolve', creatorFeature('reviews'), resolveDesignComment);
router.post('/projects/:id/comments/:commentId/reopen', creatorFeature('reviews'), reopenDesignComment);
router.post('/projects/:id/decisions', creatorFeature('reviews'), decideOnDesign);

// P4: sharing. The owner shares a design with another creator (VIEW or COMMENT) and revokes it; the collaborator sees
// what is shared with them, its review, and, with COMMENT, adds a note. The owner alone edits, resolves and approves.
router.get('/projects/:id/shares', creatorFeature('collaboration'), listProjectShares);
router.post('/projects/:id/shares', creatorFeature('collaboration'), creatorLimit('shares'), createProjectShare);
router.post('/projects/:id/shares/:shareId/revoke', creatorFeature('collaboration'), revokeProjectShare);
router.get('/shared', listSharedWithMe);
router.get('/shared/:sharedProjectId', openSharedDesign);
router.get('/shared/:sharedProjectId/review', readSharedReview);
router.post('/shared/:sharedProjectId/comments', commentOnSharedDesign);

// The creator's brand kit: colours and logos (raw image bytes in, a re-encoded PNG kept).
router.get('/brand-kit', creatorFeature('brand_studio'), readBrandKit);
router.put('/brand-kit/colours', creatorFeature('brand_studio'), saveBrandColours);
router.post('/brand-kit/assets', creatorFeature('brand_studio'), rawBrandImage, uploadBrandAsset);
router.get('/brand-kit/assets/:assetId/image', creatorFeature('brand_studio'), brandAssetImage);
router.post('/brand-kit/assets/:assetId/archive', creatorFeature('brand_studio'), archiveBrandAsset);
router.post('/brand-kit/assets/:assetId/unarchive', creatorFeature('brand_studio'), unarchiveBrandAsset);

// Team kit: rosters of names, numbers and sizes.
router.get('/rosters', creatorFeature('team_kit'), listTeamRosters);
router.post('/rosters', creatorFeature('team_kit'), createTeamRoster);
router.get('/rosters/:rosterId', creatorFeature('team_kit'), openTeamRoster);
router.put('/rosters/:rosterId', creatorFeature('team_kit'), saveTeamRoster);
router.post('/rosters/:rosterId/archive', creatorFeature('team_kit'), archiveTeamRoster);
router.post('/rosters/:rosterId/unarchive', creatorFeature('team_kit'), unarchiveTeamRoster);
router.delete('/rosters/:rosterId', creatorFeature('team_kit'), deleteTeamRoster);

// Collections and their order sheets.
router.get('/collections', creatorFeature('team_kit'), listDesignCollections);
router.post('/collections', creatorFeature('team_kit'), creatorLimit('collections'), createDesignCollection);
router.get('/collections/:collectionId', creatorFeature('team_kit'), openDesignCollection);
router.put('/collections/:collectionId', creatorFeature('team_kit'), saveDesignCollection);
router.post('/collections/:collectionId/archive', creatorFeature('team_kit'), archiveDesignCollection);
router.post('/collections/:collectionId/unarchive', creatorFeature('team_kit'), unarchiveDesignCollection);
router.delete('/collections/:collectionId', creatorFeature('team_kit'), deleteDesignCollection);
router.get('/collections/:collectionId/order-sheet', creatorFeature('team_kit'), readOrderSheet);

// Quotation requests, brokered by the Platform Owner: non-binding, nothing is charged. Sending one needs a confirmed
// address, so the Owner can answer it.
router.post('/collections/:collectionId/requests', creatorFeature('manufacturing'), requireVerifiedEmail, submitManufacturingRequest);
router.get('/requests', creatorFeature('manufacturing'), listManufacturingRequests);
router.get('/requests/:requestId', creatorFeature('manufacturing'), openManufacturingRequest);
router.post('/requests/:requestId/cancel', creatorFeature('manufacturing'), cancelManufacturingRequest);
router.post('/requests/:requestId/decline', creatorFeature('manufacturing'), declineManufacturingQuotes);
router.post('/requests/:requestId/delivered', creatorFeature('manufacturing'), confirmManufacturingDelivery);
router.post('/requests/:requestId/quotes/:quoteId/accept', creatorFeature('manufacturing'), acceptManufacturingQuote);

// P5: the professional tools, each only where the plan includes it. P6: the creator's plan, its invoices and the way to
// pay one (no payment provider is configured, so a checkout says so and charges nothing).
router.get('/projects/:id/tech-pack', creatorFeature('manufacturing_prep'), creatorTechPack);
router.post('/projects/:id/exports', creatorFeature('pro_export'), creatorProExport);
router.get('/plan', creatorBilling);
// P8: the workspace's first steps, from its own records.
router.get('/getting-started', creatorGettingStarted);
router.post('/plan/request', creatorRequestPlan);
router.post('/plan/cancel', creatorCancelPlan);
router.post('/billing/invoices/:invoiceId/checkout', creatorCheckout);

export default router;
