// Familista — the Data Fabric registry, as an API
// ─────────────────────────────────────────────────────────────────────────────
// Three reads, all of them the platform owner's, behind the SAME guard the rest
// of SYSTEM uses. There is no second authorization model here and no club role
// reaches any of it however senior it is inside its club.
//
// WHAT THESE RETURN, AND WHAT THEY DELIBERATELY DO NOT
//
// Registry METADATA and operational COUNTS. A source card says a lane exists,
// what it is called and how many events crossed it in the last minute. An event
// catalogue entry says a name is registered, what it is about and how sensitive
// it is. Neither ever carries a payload, a schema's example values, or anything
// a user typed — the catalogue is a description of contracts, and a contract is
// not the data that flows under it.
//
// Everything here is READ-ONLY. Registration happens in code at module load,
// which is the point: a registry a running process can edit over HTTP is a
// registry whose contents nobody can review.

import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { assertPlatformOwner } from '../platform/system.service';
import { fabricSources, visibleFabricSources } from '../fabric/registry/source-registry';
import { fabricEvents, fabricEventsForSource } from '../fabric/registry/event-registry';
import { fabricSchemas, schemaVersionsFor } from '../fabric/registry/schema-registry';
import { registryHealth } from '../fabric/registry/unknown-events';
import { recentFrames } from '../fabric/pulse/pulse.service';

const router = Router();
router.use(authenticate);

router.use(async (req: Request, res: Response, next) => {
  try {
    const u = (req as Request & { user?: { id?: string; clubId?: string; role?: string } }).user;
    await assertPlatformOwner({ userId: u?.id ?? '', clubId: u?.clubId ?? null, role: u?.role });
    next();
  } catch (err) { next(err); }
});

const MINUTE = 60_000;

/**
 * Per-lane counts from the live buffer.
 *
 * The buffer is bounded and in-process, so this answers "what has this instance
 * seen recently", not "what has the platform ever seen". That is the honest
 * scope of the number and the field names say so: `eventsPerMinute` counts the
 * last sixty seconds; `lastEventAt` is the most recent arrival or null.
 *
 * A source that has produced nothing gets `0` and `null` — a measured zero,
 * which is a different answer from "not instrumented" and is rendered
 * differently by everything that reads it.
 */
function laneActivity(): Map<string, { count: number; lastAt: string | null }> {
  const now = Date.now();
  const byLane = new Map<string, { count: number; lastAt: string | null }>();

  for (const frame of recentFrames()) {
    const at = new Date(frame.recordedAt).getTime();
    if (!Number.isFinite(at)) continue;
    const entry = byLane.get(frame.source) ?? { count: 0, lastAt: null };
    if (now - at <= MINUTE) entry.count += 1;
    if (!entry.lastAt || at > new Date(entry.lastAt).getTime()) entry.lastAt = frame.recordedAt;
    byLane.set(frame.source, entry);
  }
  return byLane;
}

/**
 * THE SOURCE CATALOGUE — every registered platform domain.
 *
 * `?visible=1` narrows to the ones the board draws, which is what the Live Data
 * Flow page itself would ask for. The default is everything, because a source
 * that is registered and switched off is exactly what an operator debugging a
 * missing lane needs to be able to see.
 */
router.get('/sources', (req: Request, res: Response) => {
  const activity = laneActivity();
  const all = String(req.query.visible ?? '') === '1' ? visibleFabricSources() : fabricSources();

  res.json({
    success: true,
    data: {
      sources: all.map((s) => {
        const seen = activity.get(s.name);
        return {
          id: s.id,
          name: s.name,
          icon: s.icon,
          domain: s.domain,
          description: s.description,
          category: s.category,
          order: s.order,
          enabled: s.enabled,
          showInLiveDataFlow: s.showInLiveDataFlow,
          eventDomains: [...s.eventDomains],
          /** How many event types are registered against this source. */
          registeredEventTypes: fabricEventsForSource(s.id).length,
          /**
           * `LIVE` once this instance has seen it produce, `IDLE` otherwise.
           *
           * Not `DOWN`: a lane with no traffic in the last minute is usually a
           * lane with nothing to say, and calling that an outage would be the
           * kind of invented signal this platform does not ship.
           */
          status: seen && seen.count > 0 ? 'LIVE' : 'IDLE',
          eventsPerMinute: seen ? seen.count : 0,
          lastEventAt: seen ? seen.lastAt : null,
        };
      }),
      /** Counts of what the registry has seen go wrong since this process started. */
      health: registryHealth(),
    },
  });
});

/**
 * THE EVENT CATALOGUE — every registered event type and what it is.
 *
 * Built for the consumers that do not exist yet as much as for the one that
 * does: an Audit Center deciding which types to retain, a governance surface
 * checking what carries RESTRICTED data, an agent discovering what it may
 * subscribe to. `?source=users` narrows to one domain.
 */
router.get('/events/catalog', (req: Request, res: Response) => {
  const sourceId = String(req.query.source ?? '').trim();
  const events = sourceId ? fabricEventsForSource(sourceId) : fabricEvents();

  res.json({
    success: true,
    data: {
      events: events.map((e) => ({
        type: e.type,
        describes: e.describes,
        source: e.source,
        entityType: e.entityType,
        classification: e.classification,
        schemaVersion: e.schemaVersion,
        /** Every version with a declared payload schema. Empty when none is. */
        schemaVersions: schemaVersionsFor(e.type),
        exposeInLiveStream: e.exposeInLiveStream,
        auditRelevant: e.auditRelevant,
        ...(e.legacyKind ? { legacyKind: e.legacyKind } : {}),
      })),
      total: events.length,
    },
  });
});

/**
 * THE SCHEMA CATALOGUE — which payload shapes are declared, by version.
 *
 * Names and versions only. The schemas themselves are zod objects that live in
 * code and are reviewed there; serialising one here would publish a description
 * of exactly which fields a sensitive payload carries, which is a map nobody
 * outside the code needs.
 */
router.get('/schemas', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      schemas: fabricSchemas().map((s) => ({
        eventType: s.eventType, version: s.version, describes: s.describes,
      })),
    },
  });
});

export default router;
