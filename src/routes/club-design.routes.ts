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
 * The routes and their handlers are the platform owner's (product-design.routes.ts;
 * src/platform/product-design/http.ts): only the gate and the scope differ.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { UserRole } from '@prisma/client';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { tenantParam } from '../middleware/tenant-guard.middleware';
import { isFeatureEnabled } from '../services/admin-organization.service';
import { clubScope } from '../platform/product-design/service';
import {
  archiveDesign, createDesign, listDesignRevisions, listDesigns, openDesign, openDesignRevision, restoreDesignRevision,
  saveDesign, setDesignScope, unarchiveDesign,
} from '../platform/product-design/http';

/** The entitlement that opens the Club Design Studio to a club. */
export const CLUB_DESIGN_FEATURE = 'club_design_studio';

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

router.get('/projects', listDesigns);
router.post('/projects', createDesign);
router.get('/projects/:id', tenantParam('designProject'), openDesign);
router.post('/projects/:id/revisions', tenantParam('designProject'), saveDesign);
router.get('/projects/:id/revisions', tenantParam('designProject'), listDesignRevisions);
router.get('/projects/:id/revisions/:number', tenantParam('designProject'), openDesignRevision);
router.post('/projects/:id/revisions/:number/restore', tenantParam('designProject'), restoreDesignRevision);
router.post('/projects/:id/archive', tenantParam('designProject'), archiveDesign);
router.post('/projects/:id/unarchive', tenantParam('designProject'), unarchiveDesign);

export default router;
