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
import { creatorOwns, requireVerifiedEmail } from '../platform/creator/guard';
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
router.post('/projects', createDesign);
router.get('/projects/:id', openDesign);
router.post('/projects/:id/revisions', saveDesign);
router.get('/projects/:id/revisions', listDesignRevisions);
router.get('/projects/:id/revisions/:number', openDesignRevision);
router.post('/projects/:id/revisions/:number/restore', restoreDesignRevision);
router.post('/projects/:id/archive', archiveDesign);
router.post('/projects/:id/unarchive', unarchiveDesign);

// Review notes and the creator's own approval of a version (P4 adds collaborators).
router.get('/projects/:id/review', readDesignReview);
router.post('/projects/:id/comments', commentOnDesign);
router.post('/projects/:id/comments/:commentId/resolve', resolveDesignComment);
router.post('/projects/:id/comments/:commentId/reopen', reopenDesignComment);
router.post('/projects/:id/decisions', decideOnDesign);

// The creator's brand kit: colours and logos (raw image bytes in, a re-encoded PNG kept).
router.get('/brand-kit', readBrandKit);
router.put('/brand-kit/colours', saveBrandColours);
router.post('/brand-kit/assets', rawBrandImage, uploadBrandAsset);
router.get('/brand-kit/assets/:assetId/image', brandAssetImage);
router.post('/brand-kit/assets/:assetId/archive', archiveBrandAsset);
router.post('/brand-kit/assets/:assetId/unarchive', unarchiveBrandAsset);

// Team kit: rosters of names, numbers and sizes.
router.get('/rosters', listTeamRosters);
router.post('/rosters', createTeamRoster);
router.get('/rosters/:rosterId', openTeamRoster);
router.put('/rosters/:rosterId', saveTeamRoster);
router.post('/rosters/:rosterId/archive', archiveTeamRoster);
router.post('/rosters/:rosterId/unarchive', unarchiveTeamRoster);
router.delete('/rosters/:rosterId', deleteTeamRoster);

// Collections and their order sheets.
router.get('/collections', listDesignCollections);
router.post('/collections', createDesignCollection);
router.get('/collections/:collectionId', openDesignCollection);
router.put('/collections/:collectionId', saveDesignCollection);
router.post('/collections/:collectionId/archive', archiveDesignCollection);
router.post('/collections/:collectionId/unarchive', unarchiveDesignCollection);
router.delete('/collections/:collectionId', deleteDesignCollection);
router.get('/collections/:collectionId/order-sheet', readOrderSheet);

// Quotation requests, brokered by the Platform Owner: non-binding, nothing is charged. Sending one needs a confirmed
// address, so the Owner can answer it.
router.post('/collections/:collectionId/requests', requireVerifiedEmail, submitManufacturingRequest);
router.get('/requests', listManufacturingRequests);
router.get('/requests/:requestId', openManufacturingRequest);
router.post('/requests/:requestId/cancel', cancelManufacturingRequest);
router.post('/requests/:requestId/decline', declineManufacturingQuotes);
router.post('/requests/:requestId/delivered', confirmManufacturingDelivery);
router.post('/requests/:requestId/quotes/:quoteId/accept', acceptManufacturingQuote);

export default router;
