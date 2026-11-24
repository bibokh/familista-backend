/**
 * Familista Design Studio — the HTTP handlers of the Platform Owner's rollout control (M8a), mounted by
 * src/routes/product-design.routes.ts behind authenticate and assertPlatformOwner.
 */
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { listRollout, setRollout } from './rollout.service';
import type { DesignActor } from './service';

const Setting = z.enum(['on', 'off', 'default']);
const RolloutBody = z.object({
  studio: Setting.optional(), teamKit: Setting.optional(), brandKit: Setting.optional(), manufacturing: Setting.optional(), reviews: Setting.optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'Name at least one of studio, teamKit, brandKit, manufacturing, reviews' });
const ClubId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

function actorOf(req: Request): DesignActor {
  const ua = req.headers['user-agent'];
  return { userId: req.user?.id ?? '', ipAddress: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 400) : null, correlationId: req.requestId ?? null };
}
function handler(work: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return async (req, res, next) => { try { await work(req, res); } catch (err) { next(err); } };
}

export const readRollout = handler(async (_req, res) => { res.json({ success: true, data: await listRollout() }); });
export const changeRollout = handler(async (req, res) => {
  res.json({ success: true, data: await setRollout(actorOf(req), ClubId.parse(req.params.clubId), RolloutBody.parse(req.body ?? {})) });
});
