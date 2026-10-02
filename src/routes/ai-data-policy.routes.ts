// /ai-data-policy — a club's two switches about its data and AI (Cyber Defense, R3 + R8)
//
//   GET  any member of the club reads them (the Settings card shows them).
//   PUT  a club administrator changes them, for their own (acting) club only.
//
// No id in the path: the club is the caller's, so there is nothing to guard.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { clubAiPolicy, setClubAiPolicy } from '../platform/intelligence/club-ai-policy';
import { sendSuccess } from '../utils/response';
import { BadRequestError } from '../utils/errors';

const router = Router();
router.use(authenticate);

const patchSchema = z.object({
  restrictedEgress: z.boolean().optional(),
  trainingUse: z.boolean().optional(),
}).strict().refine((b) => b.restrictedEgress !== undefined || b.trainingUse !== undefined, { message: 'nothing to change' });

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    return sendSuccess(res, await clubAiPolicy(req.user!.clubId));
  } catch (err) { return next(err); }
});

router.put('/', authorize('SUPER_ADMIN', 'CLUB_ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError('restrictedEgress and/or trainingUse (booleans) are required');
    const policy = await setClubAiPolicy({
      userId: req.user!.id, clubId: req.user!.clubId,
      ipAddress: req.ip ?? null, userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 256) : null,
    }, parsed.data);
    res.setHeader('Cache-Control', 'no-store');
    return sendSuccess(res, policy, 'Saved');
  } catch (err) { return next(err); }
});

export default router;
