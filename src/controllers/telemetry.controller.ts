// Product analytics ingestion — the only door events come through
//
// Authenticated, batched, and deliberately incurious: the body may name an
// event, a module, a feature and a route shape, and nothing else survives
// sanitize(). The environment is taken from the PROCESS, never from the
// request — a client that could name its own environment could write Lab
// traffic into the production figures.

import { Request, Response, NextFunction } from 'express';
import { track, MAX_BATCH } from '../platform/analytics/service';
import { sendSuccess } from '../utils/response';

export async function ingest(req: Request, res: Response, next: NextFunction) {
  try {
    const u = req.user as unknown as
      { id?: string; role?: string; isPlatformOwner?: boolean } | undefined;
    const body = req.body ?? {};
    const events = Array.isArray(body.events) ? body.events : [body];

    // `u.role` is NOT passed. It is `User.role`, the legacy account column, and
    // this platform's owner holds `CLUB_ADMIN` in it for historical reasons the
    // access model deliberately preserves — so stamping it on a row reported
    // the platform owner as a club administrator, including inside SYSTEM.
    // What travels is the canonical authority flag `authenticate` resolved from
    // `SUPER_ADMIN` or an active `PlatformAdmin` row; `actor-context.ts` turns
    // that, plus the workspace the event names, into the identity and tenant.
    const out = await track(
      { userId: u?.id ?? null, isPlatformOwner: u?.isPlatformOwner === true },
      events.slice(0, MAX_BATCH),
    );
    // 202: recorded, or quietly dropped. Either way the client carries on and
    // learns nothing about which of its events the allowlist refused.
    return sendSuccess(res, { accepted: out.accepted }, 'Recorded', 202);
  } catch (err) { return next(err); }
}
