/**
 * Familista Design Studio — the platform owner's saved designs (DS-1b).
 *
 * Mounted at /system/product-design. Every handler is behind authenticate and
 * assertPlatformOwner, enforced here on the server before any handler runs; the
 * room's own owner check in the browser is convenience, never the boundary.
 * Never cached. A cross-site request is refused before it gets here by the CORS
 * origin allowlist (app.ts), and a body that is not JSON never parses.
 *
 *   GET  /projects?state=active|archived          the projects, newest change first
 *   POST /projects                                 a new project from a document (revision 1)
 *   GET  /projects/:id                             a project and its newest document
 *   POST /projects/:id/revisions                   save: { baseRevision, document } → next revision, or 409
 *   GET  /projects/:id/revisions                   the revisions, newest first, without documents
 *   GET  /projects/:id/revisions/:number           one revision, with its document
 *   POST /projects/:id/revisions/:number/restore   copy it into a new revision: { baseRevision }, or 409
 *   POST /projects/:id/archive | /unarchive        archive a project, or return it to the list
 *
 * Documents are validated by the editor's own core (src/platform/product-design/core.ts);
 * a refused document answers 400 DESIGN_DOCUMENT_INVALID with the core's codes and paths.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import { DesignDocumentError } from '../platform/product-design/core';
import {
  createProject, getProject, getRevision, listProjects, listRevisions, restoreRevision, saveRevision, setArchived,
  DesignRevisionConflictError, type DesignActor,
} from '../platform/product-design/service';

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

const ProjectId = z.string().guid();
const RevisionNumber = z.coerce.number().int().min(1).max(1_000_000);
const BaseRevision = z.number().int().min(1).max(1_000_000);
const ListQuery = z.object({ state: z.enum(['active', 'archived']).default('active') });
const CreateBody = z.object({ document: z.unknown(), origin: z.enum(['EDITOR', 'FILE_IMPORT', 'BROWSER_DRAFT']) }).strict();
const SaveBody = z.object({ baseRevision: BaseRevision, document: z.unknown() }).strict();
const RestoreBody = z.object({ baseRevision: BaseRevision }).strict();

function actorOf(req: Request): DesignActor {
  const ua = req.headers['user-agent'];
  return {
    userId: req.user?.id ?? '',
    ipAddress: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 400) : null,
    correlationId: req.requestId ?? null,
  };
}

/** The refusals this room's client acts on, each with what it needs to act. */
function refusal(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof DesignDocumentError) {
    res.status(400).json({ success: false, code: 'DESIGN_DOCUMENT_INVALID', message: `The design document was refused: ${err.message}`, errors: err.problems });
    return;
  }
  if (err instanceof DesignRevisionConflictError) {
    res.status(409).json({ success: false, code: err.code, message: err.message, data: { headRevision: err.headRevision } });
    return;
  }
  next(err);
}

router.get('/projects', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { state } = ListQuery.parse(req.query);
    res.json({ success: true, data: await listProjects(state) });
  } catch (err) { refusal(err, res, next); }
});

router.post('/projects', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = CreateBody.parse(req.body);
    res.status(201).json({ success: true, data: await createProject(actorOf(req), body) });
  } catch (err) { refusal(err, res, next); }
});

router.get('/projects/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await getProject(ProjectId.parse(req.params.id)) });
  } catch (err) { refusal(err, res, next); }
});

router.post('/projects/:id/revisions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = ProjectId.parse(req.params.id);
    const body = SaveBody.parse(req.body);
    const out = await saveRevision(actorOf(req), id, body);
    res.status(out.replayed ? 200 : 201).json({ success: true, data: out });
  } catch (err) { refusal(err, res, next); }
});

router.get('/projects/:id/revisions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await listRevisions(ProjectId.parse(req.params.id)) });
  } catch (err) { refusal(err, res, next); }
});

router.get('/projects/:id/revisions/:number', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await getRevision(ProjectId.parse(req.params.id), RevisionNumber.parse(req.params.number)) });
  } catch (err) { refusal(err, res, next); }
});

router.post('/projects/:id/revisions/:number/restore', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = ProjectId.parse(req.params.id);
    const number = RevisionNumber.parse(req.params.number);
    const body = RestoreBody.parse(req.body);
    res.status(201).json({ success: true, data: await restoreRevision(actorOf(req), id, number, body) });
  } catch (err) { refusal(err, res, next); }
});

router.post('/projects/:id/archive', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await setArchived(actorOf(req), ProjectId.parse(req.params.id), true) });
  } catch (err) { refusal(err, res, next); }
});

router.post('/projects/:id/unarchive', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await setArchived(actorOf(req), ProjectId.parse(req.params.id), false) });
  } catch (err) { refusal(err, res, next); }
});

export default router;
