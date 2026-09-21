// SOURCE CORE — the provenance API
// ─────────────────────────────────────────────────────────────────────────────
// Six reads, no writes, all of them the platform owner's, behind the SAME guard
// SYSTEM, the Data Vault and Infrastructure City use. There is no second
// authorization model here and no club role reaches any of it.
//
// WHAT TRAVELS
//
// Provenance METADATA: where an input originates, how it enters, what validates
// it, where it goes, who consumes it. What never travels: an environment value,
// a connection string, a key, a token, a credential, or anything a user typed.
// The registry this composes never reads a secret in the first place — the
// discovery script does not read `process.env` at all — so there is nothing
// here to redact.
//
// WHY THERE IS NO NEW STREAM
//
// Source health IS infrastructure health, joined onto sources. The live frame
// the city already streams carries every signal this module reads, so Source
// Core subscribes to `/system/infrastructure/stream` rather than opening a
// second channel over the same thirteen readings. Adding one would double the
// sockets to say the same thing twice.

import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import {
  platformSources, sourceById, lineageFor, impactFor,
  type PlatformSource,
} from '../sources/source-registry.service';
import { fabricSources } from '../fabric/registry/source-registry';
import { laneActivity } from '../fabric/registry/lane-activity';

const router = Router();
router.use(authenticate);

router.use(async (req: Request, res: Response, next) => {
  try {
    const u = (req as Request & { user?: { id?: string; clubId?: string; role?: string } }).user;
    await assertPlatformOwner({ userId: u?.id ?? '', clubId: u?.clubId ?? null, role: u?.role });
    next();
  } catch (err) { next(err); }
});

/**
 * The live per-domain readings the Fabric registry holds.
 *
 * Fetched once per request and passed into the join, so the registry service
 * stays a pure composition and there is one place that talks to the Fabric.
 */
function liveByFabricId(): Map<string, { lastEventAt?: string | null; eventsPerMinute?: number | null }> {
  // `laneActivity` is keyed by the source's DISPLAY NAME, because that is what
  // a pulse frame carries. The registry is the only thing that can map a name
  // back to an id, so the translation happens here and exactly once.
  const activity = laneActivity();
  const out = new Map<string, { lastEventAt?: string | null; eventsPerMinute?: number | null }>();
  for (const spec of fabricSources()) {
    const seen = activity.get(spec.name);
    out.set(spec.id, {
      // A registered source that has produced nothing this minute gets a
      // measured zero and a null instant — not "not instrumented", which is a
      // different answer and is rendered differently.
      lastEventAt: seen ? seen.lastAt : null,
      eventsPerMinute: seen ? seen.count : 0,
    });
  }
  return out;
}

/** The manifest has not been generated. One shape, so every route says it alike. */
function notGenerated(res: Response, reason: string, remedy: string): void {
  res.json({
    success: true,
    data: {
      state: 'NOT_GENERATED', reason, remedy,
      note: 'Source Core renders nothing rather than guessing at an origin.',
    },
  });
}

/**
 * EVERY SOURCE — the registry, composed.
 *
 * Derived from the Data Fabric's own source registry, the infrastructure
 * manifest and the live health signals. Nothing here is a fourth opinion.
 */
router.get('/', async (_req: Request, res: Response, next) => {
  try {
    const reg = await platformSources(liveByFabricId());
    if (reg.state !== 'READY') return notGenerated(res, reg.reason!, reg.remedy!);
    return res.json({ success: true, data: reg });
  } catch (err) { return next(err); }
});

/**
 * HEALTH — the same registry reduced to state, for the landing card.
 *
 * Deliberately a projection rather than a second computation: a card that
 * disagreed with the page it links to would be worse than no card.
 */
router.get('/health', async (_req: Request, res: Response, next) => {
  try {
    const reg = await platformSources(liveByFabricId());
    if (reg.state !== 'READY') return notGenerated(res, reg.reason!, reg.remedy!);
    return res.json({
      success: true,
      data: {
        counts: reg.counts,
        overall: reg.counts.critical > 0 ? 'CRITICAL'
          : reg.counts.warning > 0 ? 'WARNING'
            : reg.counts.live > 0 ? 'HEALTHY' : 'UNKNOWN',
        // Said rather than implied: most sources are not individually measured.
        measuredNote: 'Health is joined from the thirteen signals the platform measures. '
          + 'A source nothing measures reports NOT INSTRUMENTED, never healthy.',
        measuredAt: reg.measuredAt,
        generatedAt: reg.generatedAt,
      },
    });
  } catch (err) { return next(err); }
});

/**
 * THE FLOW — five layers, as the interface draws them.
 *
 * Assembled server-side so the browser does not have to bucket forty sources
 * into layers itself and risk a different answer from the table view.
 */
router.get('/flow', async (_req: Request, res: Response, next) => {
  try {
    const reg = await platformSources(liveByFabricId());
    if (reg.state !== 'READY') return notGenerated(res, reg.reason!, reg.remedy!);

    const layer = (s: PlatformSource): string => {
      if (s.sourceType === 'FUTURE') return 'FUTURE';
      if (s.sourceType === 'TECHNOLOGY') return 'TECHNOLOGY';
      if (s.internalOrExternal === 'EXTERNAL') return 'EXTERNAL_ORIGIN';
      if (s.sourceType === 'UNREGISTERED_INTAKE') return 'UNREGISTERED_INTAKE';
      return 'INTERNAL_ORIGIN';
    };

    const origins: Record<string, PlatformSource[]> = {};
    for (const s of reg.sources) (origins[layer(s)] = origins[layer(s)] ?? []).push(s);

    return res.json({
      success: true,
      data: {
        origins,
        // The intake methods actually in use, counted from the registry.
        intake: reg.sources.reduce<Record<string, number>>((acc, s) => {
          acc[s.intake] = (acc[s.intake] ?? 0) + 1; return acc;
        }, {}),
        // The controls that run before anything is trusted, named from the
        // middleware that exists.
        validation: reg.sources.find((s) => s.controls.length)?.controls ?? [],
        consumers: ['SYSTEM', 'CLUBS', 'DATA_VAULT', 'INFRASTRUCTURE_CITY'],
        counts: reg.counts,
        measuredAt: reg.measuredAt,
      },
    });
  } catch (err) { return next(err); }
});

/** One source, in full. */
router.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const reg = await platformSources(liveByFabricId());
    if (reg.state !== 'READY') return notGenerated(res, reg.reason!, reg.remedy!);
    const s = sourceById(reg.sources, String(req.params.id ?? ''));
    if (!s) return res.status(404).json({ success: false, message: 'No such source in the registry.' });
    return res.json({ success: true, data: { source: s } });
  } catch (err) { return next(err); }
});

/** Who consumes it, and what it would take with it. */
router.get('/:id/consumers', async (req: Request, res: Response, next) => {
  try {
    const reg = await platformSources(liveByFabricId());
    if (reg.state !== 'READY') return notGenerated(res, reg.reason!, reg.remedy!);
    const s = sourceById(reg.sources, String(req.params.id ?? ''));
    if (!s) return res.status(404).json({ success: false, message: 'No such source in the registry.' });
    return res.json({
      success: true,
      data: {
        consumers: s.consumers,
        destinationModules: s.destinationModules,
        impact: impactFor(s, reg.sources),
        impactNote: 'Three degrees, kept apart: a recorded relationship, one hop '
          + 'further along the same recorded edges, and a declared destination module.',
      },
    });
  } catch (err) { return next(err); }
});

/** Origin → intake → validation → processing → destination → history. */
router.get('/:id/lineage', async (req: Request, res: Response, next) => {
  try {
    const reg = await platformSources(liveByFabricId());
    if (reg.state !== 'READY') return notGenerated(res, reg.reason!, reg.remedy!);
    const s = sourceById(reg.sources, String(req.params.id ?? ''));
    if (!s) return res.status(404).json({ success: false, message: 'No such source in the registry.' });
    return res.json({
      success: true,
      data: {
        source: { id: s.id, name: s.name, sourceType: s.sourceType },
        stages: lineageFor(s),
      },
    });
  } catch (err) { return next(err); }
});

export default router;
