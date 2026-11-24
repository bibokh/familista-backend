/**
 * Familista Design Studio — the platform owner's saved designs (DS-1b).
 *
 * Mounted at /system/product-design. Every handler is behind authenticate and
 * assertPlatformOwner, enforced here on the server before any handler runs; the
 * room's own owner check in the browser is convenience, never the boundary.
 * Never cached. A cross-site request is refused before it gets here by the CORS
 * origin allowlist (app.ts), and a body that is not JSON never parses.
 *
 * These routes reach the platform's own designs alone (PLATFORM scope); a club's
 * designs have their own mount, src/routes/club-design.routes.ts, with the same
 * handlers (src/platform/product-design/http.ts). The database holds the line
 * underneath: both tables are under row-level security.
 *
 *   GET  /projects?state=active|archived          the projects, newest change first
 *   POST /projects                                 a new project from a document (revision 1)
 *   GET  /projects/:id                             a project and its newest document
 *   POST /projects/:id/revisions                   save: { baseRevision, document } → next revision, or 409
 *   GET  /projects/:id/revisions                   the revisions, newest first, without documents
 *   GET  /projects/:id/revisions/:number           one revision, with its document
 *   POST /projects/:id/revisions/:number/restore   copy it into a new revision: { baseRevision }, or 409
 *   POST /projects/:id/archive | /unarchive        archive a project, or return it to the list
 *   GET  /rollout                                  M8a: which clubs the Club Design Studio and its parts are released to
 *   PUT  /rollout/:clubId                          set a club's release: { studio?, teamKit?, brandKit?, manufacturing?, reviews? }
 *
 * Documents are validated by the editor's own core (src/platform/product-design/core.ts);
 * a refused document answers 400 DESIGN_DOCUMENT_INVALID with the core's codes and paths.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import { PLATFORM_SCOPE } from '../platform/product-design/service';
import {
  archiveDesign, createDesign, listDesignRevisions, listDesigns, openDesign, openDesignRevision, restoreDesignRevision,
  saveDesign, setDesignScope, unarchiveDesign,
} from '../platform/product-design/http';
import { changeRollout, readRollout } from '../platform/product-design/rollout-http';

const router = Router();
router.use(authenticate);

router.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const u = req.user;
    await assertPlatformOwner({ userId: u?.id ?? '', clubId: u?.clubId ?? null, role: u?.role });
    setDesignScope(res, PLATFORM_SCOPE);
    res.setHeader('Cache-Control', 'no-store');
    next();
  } catch (err) { next(err); }
});

router.get('/projects', listDesigns);
// M8a: the Owner releases the Club Design Studio, and each of its parts, to the clubs invited to it.
router.get('/rollout', readRollout);
router.put('/rollout/:clubId', changeRollout);
router.post('/projects', createDesign);
router.get('/projects/:id', openDesign);
router.post('/projects/:id/revisions', saveDesign);
router.get('/projects/:id/revisions', listDesignRevisions);
router.get('/projects/:id/revisions/:number', openDesignRevision);
router.post('/projects/:id/revisions/:number/restore', restoreDesignRevision);
router.post('/projects/:id/archive', archiveDesign);
router.post('/projects/:id/unarchive', unarchiveDesign);

export default router;
