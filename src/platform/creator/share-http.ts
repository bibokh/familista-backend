/**
 * Familista Creator Studio (P4) — the HTTP handlers of sharing: the owner's shares of a design, and the designs shared
 * with the signed-in creator, their review and (with COMMENT) a note on them. Mounted by src/routes/creator.routes.ts,
 * behind authenticateCreator; a design id is checked against its owner (router.param creatorOwns) and a shared design
 * against a live share with the signed-in creator (router.param creatorSharedWith), before any handler runs.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { addComment, getReview, ReviewInvalidError } from '../product-design/review.service';
import { designActorOf } from '../product-design/scope-http';
import { creatorTenant } from '../tenancy/tenant';
import { listShares, openShared, revokeShare, ShareRefusedError, shareProject, sharedWithMe, type LiveShare } from './share.service';

const Id = z.string().guid();
const ShareBody = z.object({ email: z.string().max(254), role: z.enum(['VIEW', 'COMMENT']) }).strict();
const CommentBody = z.object({ revision: z.number().int().min(1).max(1_000_000), surface: z.string().max(40).nullable().default(null), body: z.string().max(4000) }).strict();

function handler(work: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try { await work(req, res); } catch (err) {
      if (err instanceof ShareRefusedError) { res.status(err.reason === 'no-creator' ? 404 : err.reason === 'lookup-limit' ? 429 : err.reason === 'exists' || err.reason === 'limit' ? 409 : 400).json({ success: false, code: err.code, reason: err.reason, message: err.message }); return; }
      if (err instanceof ReviewInvalidError) { res.status(400).json({ success: false, code: 'REVIEW_INVALID', reason: err.code, path: err.path, message: err.message }); return; }
      next(err);
    }
  };
}
const me = (req: Request) => (req.creator as { id: string }).id;
const shareOf = (res: Response) => res.locals.share as LiveShare;

export const listProjectShares = handler(async (req, res) => { res.json({ success: true, data: await listShares(me(req), Id.parse(req.params.id)) }); });
export const createProjectShare = handler(async (req, res) => {
  res.status(201).json({ success: true, data: await shareProject(me(req), designActorOf(req), Id.parse(req.params.id), ShareBody.parse(req.body)) });
});
export const revokeProjectShare = handler(async (req, res) => {
  res.json({ success: true, data: await revokeShare(me(req), designActorOf(req), Id.parse(req.params.id), Id.parse(req.params.shareId)) });
});
export const listSharedWithMe = handler(async (req, res) => { res.json({ success: true, data: await sharedWithMe(me(req)) }); });
export const openSharedDesign = handler(async (req, res) => { res.json({ success: true, data: await openShared(shareOf(res), Id.parse(req.params.sharedProjectId)) }); });
export const readSharedReview = handler(async (req, res) => {
  const s = shareOf(res);
  res.json({ success: true, data: { ...(await getReview(creatorTenant(s.creatorId), Id.parse(req.params.sharedProjectId))), role: s.role } });
});
/** A collaborator's note: only with COMMENT, written as the collaborator on the owner's design (and only so, underneath). */
export const commentOnSharedDesign = handler(async (req, res) => {
  const s = shareOf(res);
  if (s.role !== 'COMMENT') { res.status(403).json({ success: false, code: 'SHARE_VIEW_ONLY', message: 'This design is shared with you to see, not to comment on' }); return; }
  res.status(201).json({ success: true, data: await addComment(creatorTenant(s.creatorId), designActorOf(req), Id.parse(req.params.sharedProjectId), CommentBody.parse(req.body)) });
});
