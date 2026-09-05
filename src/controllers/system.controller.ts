// SYSTEM — HTTP shim over platform/system.service.ts
//
// Every handler is platform-owner only, checked in the service as well as at
// the route. Nothing here is club-scoped, and nothing club-scoped belongs here.

import { Request, Response, NextFunction } from 'express';
import * as system from '../platform/system.service';
import { SYSTEM_MODULES } from '../platform/system-modules';
import { describeAuthority } from '../platform/access-levels';
import { engageKillSwitch, releaseKillSwitch } from '../platform/intelligence/agents';
import { defineFlag, listFlags, isEnabled, type FlagAudience } from '../platform/innovation/flags';
import { decideExperiment, registerExperiment, listExperiments, type ExperimentStatus } from '../platform/innovation/experiments';
import { currentEnvironment, type FamilistaEnvironment } from '../platform/environment';
import { publish } from '../platform/events/bus';
import { sendSuccess } from '../utils/response';
import { BadRequestError } from '../utils/errors';

function actorOf(req: Request): { userId: string; clubId: string | null; role?: string } {
  const u = req.user as unknown as { id?: string; role?: string; clubId?: string } | undefined;
  return { userId: u?.id ?? '', clubId: u?.clubId ?? null, role: u?.role };
}

/** Who the caller is, in platform terms. The SYSTEM shell asks before drawing. */
export async function whoAmI(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await describeAuthority(actorOf(req)));
  } catch (err) { return next(err); }
}

export async function modules(req: Request, res: Response, next: NextFunction) {
  try {
    await system.assertPlatformOwner(actorOf(req));
    return sendSuccess(res, { modules: SYSTEM_MODULES });
  } catch (err) { return next(err); }
}

export async function overview(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await system.platformOverview(actorOf(req)));
  } catch (err) { return next(err); }
}

export async function clubs(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, { clubs: await system.listClubs(actorOf(req)) });
  } catch (err) { return next(err); }
}

export async function people(req: Request, res: Response, next: NextFunction) {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const clubId = typeof req.query.clubId === 'string' ? req.query.clubId : undefined;
    return sendSuccess(res, { people: await system.listPeople(actorOf(req), { search, clubId }) });
  } catch (err) { return next(err); }
}


// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export async function signals(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, { signals: await system.platformSignals(actorOf(req)) });
  } catch (err) { return next(err); }
}

export async function capabilities(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await system.controlSurface(actorOf(req)));
  } catch (err) { return next(err); }
}

export async function intelligence(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await system.intelligenceSurface(actorOf(req)));
  } catch (err) { return next(err); }
}

export async function innovation(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await system.innovationSurface(actorOf(req)));
  } catch (err) { return next(err); }
}

export async function governance(req: Request, res: Response, next: NextFunction) {
  try {
    const q = req.query as Record<string, string | undefined>;
    return sendSuccess(res, await system.governanceSurface(actorOf(req), {
      actorLevel: q.actorLevel as never,
      jurisdiction: q.jurisdiction,
      resource: q.resource,
      action: q.action as never,
      subjectIsMinor: q.subjectIsMinor === 'true',
      aiInvolved: q.aiInvolved === 'true',
      consentGiven: q.consentGiven === 'true',
    }));
  } catch (err) { return next(err); }
}

export async function security(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await system.securitySurface(actorOf(req)));
  } catch (err) { return next(err); }
}

export async function audit(req: Request, res: Response, next: NextFunction) {
  try {
    return sendSuccess(res, await system.auditSurface(actorOf(req)));
  } catch (err) { return next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Controls
// ─────────────────────────────────────────────────────────────────────────────
//
// Each one asserts platform authority first, performs a real change, and
// publishes the event that records it. There are no decorative handlers here:
// a control that cannot act is declared NOT_AVAILABLE in the capability
// catalogue and has no endpoint at all.

const AUDIENCES = ['OWNER_ONLY', 'INTERNAL', 'SELECTED_USERS', 'SELECTED_CLUBS', 'PERCENTAGE_ROLLOUT', 'PUBLIC'];

/** Stop, or resume, autonomous AI actions across the platform. */
export async function killSwitch(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await system.assertPlatformOwner(actor);
    const engage = req.body?.engage !== false;
    const reason = String(req.body?.reason ?? '').trim();
    if (engage && !reason) throw new BadRequestError('Say why: the reason is shown to anyone who finds an agent refused.');

    if (engage) engageKillSwitch(reason); else releaseKillSwitch();
    publish({
      name: engage ? 'AIActionRefused' : 'AIActionExecuted',
      actor: { type: 'PLATFORM_OWNER', id: actor.userId },
      payload: { control: 'kill-switch', engaged: engage, reason: engage ? reason : null },
    });
    return sendSuccess(res, await system.intelligenceSurface(actor),
      engage ? 'Autonomous AI actions stopped' : 'Autonomous AI actions resumed');
  } catch (err) { return next(err); }
}

/**
 * Define or retarget a feature flag.
 *
 * The whole shape is sent every time rather than patched: a flag's audience and
 * its environments decide who sees an unfinished feature, and a partial update
 * that leaves one of them behind is exactly how an experiment escapes.
 */
export async function setFlag(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await system.assertPlatformOwner(actor);
    const key = String(req.params.key ?? '').trim();
    if (!key) throw new BadRequestError('A flag key is required');

    const body = req.body ?? {};
    const audience = String(body.audience ?? 'OWNER_ONLY');
    if (!AUDIENCES.includes(audience)) throw new BadRequestError(`Unknown audience "${audience}"`);
    const environments = Array.isArray(body.environments) && body.environments.length
      ? (body.environments as FamilistaEnvironment[])
      : ([currentEnvironment()] as FamilistaEnvironment[]);

    defineFlag({
      key,
      description: typeof body.description === 'string' ? body.description : undefined,
      environments,
      audience: audience as FlagAudience,
      userIds: Array.isArray(body.userIds) ? body.userIds.map(String) : undefined,
      clubIds: Array.isArray(body.clubIds) ? body.clubIds.map(String) : undefined,
      percentage: typeof body.percentage === 'number' ? body.percentage : undefined,
      enabled: body.enabled !== false,
    });

    publish({
      name: 'FeatureFlagChanged',
      actor: { type: 'PLATFORM_OWNER', id: actor.userId },
      payload: { key, audience, environments, enabled: body.enabled !== false },
    });
    return sendSuccess(res, { flags: listFlags(), reachesOwner: isEnabled(key, { isPlatformOwner: true }) }, 'Flag updated');
  } catch (err) { return next(err); }
}

export async function createExperiment(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await system.assertPlatformOwner(actor);
    const body = req.body ?? {};
    const title = String(body.title ?? '').trim();
    if (!title) throw new BadRequestError('An experiment needs a title');

    const record = registerExperiment({
      id: String(body.id ?? `exp-${Date.now()}`),
      flagKey: typeof body.flagKey === 'string' ? body.flagKey : null,
      title,
      hypothesis: String(body.hypothesis ?? ''),
      successMetrics: Array.isArray(body.successMetrics) ? body.successMetrics.map(String) : [],
      ownerUserId: actor.userId,
      modelVersions: Array.isArray(body.modelVersions) ? body.modelVersions.map(String) : undefined,
      costNote: typeof body.costNote === 'string' ? body.costNote : null,
    });
    publish({
      name: 'ExperimentStarted',
      actor: { type: 'PLATFORM_OWNER', id: actor.userId },
      payload: { experimentId: record.id, environment: record.environment },
    });
    return sendSuccess(res, { experiments: listExperiments() }, 'Experiment registered');
  } catch (err) { return next(err); }
}

export async function decideExperimentState(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = actorOf(req);
    await system.assertPlatformOwner(actor);
    const id = String(req.params.id ?? '');
    const next_ = String(req.body?.status ?? '') as ExperimentStatus;
    const record = decideExperiment(id, next_, typeof req.body?.note === 'string' ? req.body.note : undefined);
    publish({
      name: 'ExperimentDecided',
      actor: { type: 'PLATFORM_OWNER', id: actor.userId },
      payload: { experimentId: id, status: record.status },
    });
    return sendSuccess(res, { experiments: listExperiments() }, `Experiment ${record.status.toLowerCase()}`);
  } catch (err) { return next(err); }
}
