/**
 * Familista Design Studio — the HTTP handlers of a club's design reviews (M7b), mounted by src/routes/club-design.routes.ts
 * behind its gate (authenticate, the club roles that design kits, the club's entitlement, the reviews part). The club is
 * the one the gate resolved from the session; a handler reached without a club scope refuses, never serves.
 */
import type { Request, RequestHandler, Response } from 'express';
import { designActorOf as actorOf, tenantOfRes } from './scope-http';
import type { Tenant } from '../tenancy/tenant';
import { DesignReviewDecision, UserRole } from '@prisma/client';
import { z } from 'zod';
import { addComment, decide, getReview, setCommentResolved, ReviewInvalidError, ReviewStaleError } from './review.service';
import type { DesignActor, DesignScope } from './service';

const Id = z.string().guid();
const CommentBody = z.object({ revision: z.number().int().min(1).max(1_000_000), surface: z.string().max(40).nullable().default(null), body: z.string().max(4000) }).strict();
const DecisionBody = z.object({
  revision: z.number().int().min(1).max(1_000_000),
  decision: z.enum([DesignReviewDecision.APPROVED, DesignReviewDecision.CHANGES_REQUESTED]),
  note: z.string().max(4000).nullable().default(null),
}).strict();

function handler(work: (req: Request, res: Response, tenant: Tenant) => Promise<void>): RequestHandler {
  return async (req, res, next) => {
    try { await work(req, res, tenantOfRes(res)); } catch (err) {
      if (err instanceof ReviewInvalidError) { res.status(400).json({ success: false, code: 'REVIEW_INVALID', reason: err.code, path: err.path, message: err.message }); return; }
      if (err instanceof ReviewStaleError) { res.status(409).json({ success: false, code: err.code, data: { headRevision: err.headRevision }, message: err.message }); return; }
      next(err);
    }
  };
}

export const readDesignReview = handler(async (req, res, tenant) => { res.json({ success: true, data: await getReview(tenant, Id.parse(req.params.id)) }); });
export const commentOnDesign = handler(async (req, res, tenant) => {
  res.status(201).json({ success: true, data: await addComment(tenant, actorOf(req), Id.parse(req.params.id), CommentBody.parse(req.body)) });
});
const resolveTo = (resolved: boolean) => handler(async (req, res, tenant) => {
  res.json({ success: true, data: await setCommentResolved(tenant, actorOf(req), Id.parse(req.params.id), Id.parse(req.params.commentId), resolved) });
});
export const resolveDesignComment = resolveTo(true);
export const reopenDesignComment = resolveTo(false);
export const decideOnDesign = handler(async (req, res, tenant) => {
  res.status(201).json({ success: true, data: await decide(tenant, actorOf(req), Id.parse(req.params.id), DecisionBody.parse(req.body)) });
});
