/**
 * Familista Design Studio — the HTTP handlers of the saved-design routes, written once and mounted twice:
 * the platform owner's (src/routes/product-design.routes.ts) and a club's (src/routes/club-design.routes.ts).
 *
 * A handler never chooses whose designs it reaches: its mount's gate resolves the scope on the server (the
 * platform's own, or the signed-in user's club) and leaves it in `res.locals.designScope`; a request that
 * reached a handler without one is a programming error and is refused, never served unscoped.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { DesignDocumentError } from './core';
import { designActorOf } from './scope-http';
import {
  createProject, getProject, getRevision, listProjects, listRevisions, restoreRevision, saveRevision, setArchived,
  DesignRevisionConflictError, type DesignActor, type DesignScope,
} from './service';

const ProjectId = z.string().guid();
const RevisionNumber = z.coerce.number().int().min(1).max(1_000_000);
const BaseRevision = z.number().int().min(1).max(1_000_000);
const ListQuery = z.object({ state: z.enum(['active', 'archived']).default('active') });
const CreateBody = z.object({ document: z.unknown(), origin: z.enum(['EDITOR', 'FILE_IMPORT', 'BROWSER_DRAFT']) }).strict();
const SaveBody = z.object({ baseRevision: BaseRevision, document: z.unknown() }).strict();
const RestoreBody = z.object({ baseRevision: BaseRevision }).strict();

/** Where a mount's gate leaves the scope it resolved. */
export function setDesignScope(res: Response, scope: DesignScope): void { res.locals.designScope = scope; }
function scopeOf(res: Response): DesignScope {
  const s = res.locals.designScope as DesignScope | undefined;
  if (!s || (s.kind !== 'PLATFORM' && s.kind !== 'CLUB' && s.kind !== 'PERSONAL')) throw new Error('A design route was reached without a scope');
  return s;
}

function actorOf(req: Request): DesignActor {
  const { role: _role, ...actor } = designActorOf(req); // eslint-disable-line @typescript-eslint/no-unused-vars
  return actor;
}

/** The refusals the room's client acts on, each with what it needs to act. */
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

/** One handler: its work, in its mount's scope, with the refusals answered as the client expects. */
function handler(work: (req: Request, res: Response, scope: DesignScope) => Promise<void>): RequestHandler {
  return async (req, res, next) => {
    try { await work(req, res, scopeOf(res)); } catch (err) { refusal(err, res, next); }
  };
}

export const listDesigns = handler(async (req, res, scope) => {
  const { state } = ListQuery.parse(req.query);
  res.json({ success: true, data: await listProjects(scope, state) });
});
export const createDesign = handler(async (req, res, scope) => {
  const body = CreateBody.parse(req.body);
  res.status(201).json({ success: true, data: await createProject(scope, actorOf(req), body) });
});
export const openDesign = handler(async (req, res, scope) => {
  res.json({ success: true, data: await getProject(scope, ProjectId.parse(req.params.id)) });
});
export const saveDesign = handler(async (req, res, scope) => {
  const id = ProjectId.parse(req.params.id);
  const body = SaveBody.parse(req.body);
  const out = await saveRevision(scope, actorOf(req), id, body);
  res.status(out.replayed ? 200 : 201).json({ success: true, data: out });
});
export const listDesignRevisions = handler(async (req, res, scope) => {
  res.json({ success: true, data: await listRevisions(scope, ProjectId.parse(req.params.id)) });
});
export const openDesignRevision = handler(async (req, res, scope) => {
  res.json({ success: true, data: await getRevision(scope, ProjectId.parse(req.params.id), RevisionNumber.parse(req.params.number)) });
});
export const restoreDesignRevision = handler(async (req, res, scope) => {
  const id = ProjectId.parse(req.params.id);
  const number = RevisionNumber.parse(req.params.number);
  const body = RestoreBody.parse(req.body);
  res.status(201).json({ success: true, data: await restoreRevision(scope, actorOf(req), id, number, body) });
});
export const archiveDesign = handler(async (req, res, scope) => {
  res.json({ success: true, data: await setArchived(scope, actorOf(req), ProjectId.parse(req.params.id), true) });
});
export const unarchiveDesign = handler(async (req, res, scope) => {
  res.json({ success: true, data: await setArchived(scope, actorOf(req), ProjectId.parse(req.params.id), false) });
});
