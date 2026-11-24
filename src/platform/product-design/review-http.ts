/**
 * Familista Design Studio — the HTTP handlers of a club's design reviews (M7b), mounted by src/routes/club-design.routes.ts
 * behind its gate (authenticate, the club roles that design kits, the club's entitlement, the reviews part). The club is
 * the one the gate resolved from the session; a handler reached without a club scope refuses, never serves.
 */
import type { Request, RequestHandler, Response } from 'express';
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

function clubOf(res: Response): string {
  const s = res.locals.designScope as DesignScope | undefined;
  if (!s || s.kind !== 'CLUB') throw new Error('A review route was reached without a club scope');
  return s.clubId;
}
function actorOf(req: Request): DesignActor & { role: UserRole } {
  const ua = req.headers['user-agent'];
  return { userId: req.user?.id ?? '', role: req.user?.role as UserRole, ipAddress: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 400) : null, correlationId: req.requestId ?? null };
}
function handler(work: (req: Request, res: Response, clubId: string) => Promise<void>): RequestHandler {
  return async (req, res, next) => {
    try { await work(req, res, clubOf(res)); } catch (err) {
      if (err instanceof ReviewInvalidError) { res.status(400).json({ success: false, code: 'REVIEW_INVALID', reason: err.code, path: err.path, message: err.message }); return; }
      if (err instanceof ReviewStaleError) { res.status(409).json({ success: false, code: err.code, data: { headRevision: err.headRevision }, message: err.message }); return; }
      next(err);
    }
  };
}

export const readDesignReview = handler(async (req, res, clubId) => { res.json({ success: true, data: await getReview(clubId, Id.parse(req.params.id)) }); });
export const commentOnDesign = handler(async (req, res, clubId) => {
  res.status(201).json({ success: true, data: await addComment(clubId, actorOf(req), Id.parse(req.params.id), CommentBody.parse(req.body)) });
});
const resolveTo = (resolved: boolean) => handler(async (req, res, clubId) => {
  res.json({ success: true, data: await setCommentResolved(clubId, actorOf(req), Id.parse(req.params.id), Id.parse(req.params.commentId), resolved) });
});
export const resolveDesignComment = resolveTo(true);
export const reopenDesignComment = resolveTo(false);
export const decideOnDesign = handler(async (req, res, clubId) => {
  res.status(201).json({ success: true, data: await decide(clubId, actorOf(req), Id.parse(req.params.id), DecisionBody.parse(req.body)) });
});
