/**
 * Familista Design Studio — a club's saved designs: the Club Design Studio (M2).
 *
 * Mounted at /club-design. Every handler is behind, in this order, enforced here
 * on the server before any handler runs:
 *   authenticate                           a session; its request runs in its club's
 *                                          database context (auth.middleware.ts);
 *   authorize(CLUB_ADMIN, MANAGER)         the club roles that design the club's kits;
 *   the club's entitlement                 `club_design_studio`, off for every club and
 *                                          plan until the platform owner turns it on
 *                                          (a club override or a plan): 403
 *                                          DESIGN_STUDIO_NOT_ENABLED otherwise.
 * The club is always the signed-in user's own (CLUB scope); no request names it. A
 * project id is checked against the caller's club before its handler runs
 * (tenantParam('designProject')), and a project of any other scope is not found by
 * the service, whatever its id. The database holds the
 * same line underneath: both tables are under row-level security
 * (20261122200000_design_studio_club_projects). Never cached; a cross-site request is
 * refused by the CORS origin allowlist (app.ts) before it gets here.
 *
 * The project routes and their handlers are the platform owner's (product-design.routes.ts;
 * src/platform/product-design/http.ts): only the gate and the scope differ. The brand-kit routes are the club's own
 * (src/platform/product-design/brand-http.ts, M2c), and so are its team rosters (roster-http.ts, M3a) and its collections
 * (collection-http.ts, M3b).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { UserRole } from '@prisma/client';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { tenantParam } from '../middleware/tenant-guard.middleware';
import { isFeatureEnabled } from '../services/admin-organization.service';
import { CLUB_DESIGN_FEATURE, clubScope } from '../platform/product-design/service';
import { designPartEnabled, DESIGN_PARTS, type DesignPart } from '../platform/product-design/entitlements';
import {
  archiveDesign, createDesign, listDesignRevisions, listDesigns, openDesign, openDesignRevision, restoreDesignRevision,
  saveDesign, setDesignScope, unarchiveDesign,
} from '../platform/product-design/http';
import {
  archiveBrandAsset, brandAssetImage, rawBrandImage, readBrandKit, saveBrandColours, unarchiveBrandAsset, uploadBrandAsset,
} from '../platform/product-design/brand-http';
import {
  archiveTeamRoster, createTeamRoster, deleteTeamRoster, listTeamRosters, openTeamRoster, readSquadNames, saveTeamRoster, unarchiveTeamRoster,
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
import { clubErasePerson } from '../platform/privacy/privacy-http';

const router = Router();
router.use(authenticate);
router.use(authorize(UserRole.CLUB_ADMIN, UserRole.MANAGER));

router.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clubId = req.user?.clubId;
    if (!clubId || !(await isFeatureEnabled(clubId, CLUB_DESIGN_FEATURE))) {
      res.status(403).json({ success: false, code: 'DESIGN_STUDIO_NOT_ENABLED', message: 'The Club Design Studio is not enabled for this club' });
      return;
    }
    setDesignScope(res, clubScope(clubId));
    res.setHeader('Cache-Control', 'no-store');
    next();
  } catch (err) { next(err); }
});

/**
 * A part of the studio the club's plan must include (M7a): refused with 403 DESIGN_FEATURE_NOT_ENABLED and the part's
 * key, before its handler runs. The club is the session's, as above.
 */
function requirePart(part: DesignPart) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await designPartEnabled(req.user?.clubId ?? '', part))) {
        res.status(403).json({ success: false, code: 'DESIGN_FEATURE_NOT_ENABLED', feature: DESIGN_PARTS[part], message: 'This part of the Club Design Studio is not included in the club’s plan' });
        return;
      }
      next();
    } catch (err) { next(err); }
  };
}
const teamKit = requirePart('teamKit'), brandKit = requirePart('brandKit'), manufacturing = requirePart('manufacturing'), reviews = requirePart('reviews');

router.get('/projects', listDesigns);
router.post('/projects', createDesign);
router.get('/projects/:id', tenantParam('designProject'), openDesign);
router.post('/projects/:id/revisions', tenantParam('designProject'), saveDesign);
router.get('/projects/:id/revisions', tenantParam('designProject'), listDesignRevisions);
router.get('/projects/:id/revisions/:number', tenantParam('designProject'), openDesignRevision);
router.post('/projects/:id/revisions/:number/restore', tenantParam('designProject'), restoreDesignRevision);
router.post('/projects/:id/archive', tenantParam('designProject'), archiveDesign);
router.post('/projects/:id/unarchive', tenantParam('designProject'), unarchiveDesign);

// Reviews and approvals (M7b): comments on a saved version, and a club administrator's decision on the newest one (the
// service refuses a manager). A comment id is checked against the caller's club before its handler runs.
router.get('/projects/:id/review', reviews, tenantParam('designProject'), readDesignReview);
router.post('/projects/:id/comments', reviews, tenantParam('designProject'), commentOnDesign);
router.post('/projects/:id/comments/:commentId/resolve', reviews, tenantParam('designProject'), tenantParam('designReviewComment', 'commentId'), resolveDesignComment);
router.post('/projects/:id/comments/:commentId/reopen', reviews, tenantParam('designProject'), tenantParam('designReviewComment', 'commentId'), reopenDesignComment);
router.post('/projects/:id/decisions', reviews, tenantParam('designProject'), decideOnDesign);

// The club's brand kit (M2c): its colours and its logos. An upload is raw image bytes, at most UPLOAD_LIMITS.bytes,
// read by this route alone; what is kept is the PNG the server re-encodes from it (brand-image.ts).
router.get('/brand-kit', brandKit, readBrandKit);
router.put('/brand-kit/colours', brandKit, saveBrandColours);
router.post('/brand-kit/assets', brandKit, rawBrandImage, uploadBrandAsset);
router.get('/brand-kit/assets/:assetId/image', brandKit, tenantParam('designBrandAsset', 'assetId'), brandAssetImage);
router.post('/brand-kit/assets/:assetId/archive', brandKit, tenantParam('designBrandAsset', 'assetId'), archiveBrandAsset);
router.post('/brand-kit/assets/:assetId/unarchive', brandKit, tenantParam('designBrandAsset', 'assetId'), unarchiveBrandAsset);

// The club's team rosters (M3): the names, numbers and sizes its kits are made for. A roster id is checked against the
// caller's club before its handler runs. The squad's names are the club's own active players, surname and number only.
router.get('/rosters', teamKit, listTeamRosters);
router.post('/rosters', teamKit, createTeamRoster);
router.get('/rosters/:rosterId', teamKit, tenantParam('designRoster', 'rosterId'), openTeamRoster);
router.put('/rosters/:rosterId', teamKit, tenantParam('designRoster', 'rosterId'), saveTeamRoster);
router.post('/rosters/:rosterId/archive', teamKit, tenantParam('designRoster', 'rosterId'), archiveTeamRoster);
router.post('/rosters/:rosterId/unarchive', teamKit, tenantParam('designRoster', 'rosterId'), unarchiveTeamRoster);
router.delete('/rosters/:rosterId', teamKit, tenantParam('designRoster', 'rosterId'), deleteTeamRoster);
router.get('/squad-names', teamKit, readSquadNames);
// P1: a club administrator erases a person's name from the club's design data (previewed first; the service refuses
// anyone else). Not a part of the plan: wherever the studio is, its data can be erased.
router.post('/privacy/erase-person', clubErasePerson);

// The club's collections (M3b): its designs gathered as one kit, and the order sheet a roster makes of it. A collection
// id is checked against the caller's club before its handler runs; the designs and the roster it names are checked by
// the service, and held to the club by the database (composite keys and a trigger).
router.get('/collections', teamKit, listDesignCollections);
router.post('/collections', teamKit, createDesignCollection);
router.get('/collections/:collectionId', teamKit, tenantParam('designCollection', 'collectionId'), openDesignCollection);
router.put('/collections/:collectionId', teamKit, tenantParam('designCollection', 'collectionId'), saveDesignCollection);
router.post('/collections/:collectionId/archive', teamKit, tenantParam('designCollection', 'collectionId'), archiveDesignCollection);
router.post('/collections/:collectionId/unarchive', teamKit, tenantParam('designCollection', 'collectionId'), unarchiveDesignCollection);
router.delete('/collections/:collectionId', teamKit, tenantParam('designCollection', 'collectionId'), deleteDesignCollection);
router.get('/collections/:collectionId/order-sheet', teamKit, tenantParam('designCollection', 'collectionId'), readOrderSheet);

// Manufacturing (M4), owner-brokered: the club's requests for quotation. A request is submitted from one of the club's
// collections; a request id and a quotation id are each checked against the caller's club before the handler runs. The
// club reads only quotations the Platform Owner published, and moves a request only by the club's own steps.
router.post('/collections/:collectionId/requests', manufacturing, tenantParam('designCollection', 'collectionId'), submitManufacturingRequest);
router.get('/requests', manufacturing, listManufacturingRequests);
router.get('/requests/:requestId', manufacturing, tenantParam('manufacturingRequest', 'requestId'), openManufacturingRequest);
router.post('/requests/:requestId/cancel', manufacturing, tenantParam('manufacturingRequest', 'requestId'), cancelManufacturingRequest);
router.post('/requests/:requestId/decline', manufacturing, tenantParam('manufacturingRequest', 'requestId'), declineManufacturingQuotes);
router.post('/requests/:requestId/delivered', manufacturing, tenantParam('manufacturingRequest', 'requestId'), confirmManufacturingDelivery);
router.post('/requests/:requestId/quotes/:quoteId/accept', manufacturing, tenantParam('manufacturingRequest', 'requestId'), tenantParam('manufacturingQuote', 'quoteId'), acceptManufacturingQuote);

export default router;
