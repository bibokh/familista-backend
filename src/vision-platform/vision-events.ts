// FAMILISTA VISION — the events, on the transport the platform already has
// ─────────────────────────────────────────────────────────────────────────────
// WHY THERE IS NO VISION EVENT BUS
//
// Because there is a Familista event bus, and a second one would mean two
// answers to "what happened, and when". These names register into the Fabric's
// own event registry alongside every other domain's, travel through `emit` into
// the same outbox, land in the same durable history, and are read by the same
// Data Vault. Vision is a producer on the platform's nervous system, not a
// nervous system of its own.
//
// WHAT MAY BE SAID, AND WHAT MAY NOT
//
// Every name below describes something the VALIDATED engine actually
// determines. There is no VISION_PASS_COMPLETED, no VISION_SHOT, no
// VISION_PLAYER_RATED, because the engine does not determine those things and
// an event is a claim. `VISION_EVENT_PROXIMITY` exists and says proximity;
// `VISION_EVENT_CONTROL` exists because the engine confirms control against
// ball evidence rather than distance. Proximity is not possession, and the
// vocabulary says so by having two words for two different findings.
//
// CALIBRATION GETS THREE NAMES, NOT A BOOLEAN
//
// VALID, DEGRADED and NONE are three different operational situations — a
// metric answer you can trust, one carrying a wide error bar, and no metric
// answer at all. A boolean would collapse the last two, and the last two are
// exactly where a consumer must behave differently.

import { z } from 'zod';

import { registerFabricEvents, type FabricEventSpec } from '../fabric/registry/event-registry';
import { registerFabricSchema } from '../fabric/registry/schema-registry';

/** Every Vision event name, in one place, so a consumer can enumerate them. */
export const VISION_EVENTS = {
  SESSION_CREATED: 'vision.session.created',
  SESSION_STARTED: 'vision.session.started',
  SESSION_PROCESSING: 'vision.session.processing',
  SESSION_COMPLETED: 'vision.session.completed',
  SESSION_FAILED: 'vision.session.failed',

  SOURCE_CONNECTED: 'vision.source.connected',
  SOURCE_DISCONNECTED: 'vision.source.disconnected',
  SOURCE_DEGRADED: 'vision.source.degraded',

  PLAYER_TRACK_OBSERVED: 'vision.player.track.observed',
  BALL_OBSERVED: 'vision.ball.observed',
  BALL_PROPAGATED: 'vision.ball.propagated',

  CALIBRATION_VALID: 'vision.calibration.valid',
  CALIBRATION_DEGRADED: 'vision.calibration.degraded',
  CALIBRATION_NONE: 'vision.calibration.none',

  EVENT_CONTROL: 'vision.event.control',
  EVENT_PROXIMITY: 'vision.event.proximity',
  EVENT_POSSESSION_TRANSITION: 'vision.event.possession.transition',
} as const;

export type VisionEventName = (typeof VISION_EVENTS)[keyof typeof VISION_EVENTS];

/** The Fabric source id Vision produces under. Registered in `vision-source.ts`. */
export const VISION_SOURCE_ID = 'vision';

const SCHEMA_VERSION = 1;

interface Spec {
  type: string;
  describes: string;
  entityType: string | null;
  /**
   * Whether the live monitoring board may draw it.
   *
   * The three per-observation names are false. A ten-second clip produces four
   * thousand player observations; putting them on a firehose would drown every
   * other domain's events in one session's worth of tracking and tell an
   * operator nothing they could act on. They are still durable, still queryable
   * and still in the Vault — withheld from the LIVE VIEW is not withheld.
   */
  live: boolean;
}

const SPECS: Spec[] = [
  { type: VISION_EVENTS.SESSION_CREATED, describes: 'A Vision session was created for a source', entityType: 'VISION_SESSION', live: true },
  { type: VISION_EVENTS.SESSION_STARTED, describes: 'A Vision session began processing', entityType: 'VISION_SESSION', live: true },
  { type: VISION_EVENTS.SESSION_PROCESSING, describes: 'A Vision session reported processing progress', entityType: 'VISION_SESSION', live: true },
  { type: VISION_EVENTS.SESSION_COMPLETED, describes: 'A Vision session finished and its evidence is available', entityType: 'VISION_SESSION', live: true },
  { type: VISION_EVENTS.SESSION_FAILED, describes: 'A Vision session stopped without producing evidence', entityType: 'VISION_SESSION', live: true },

  { type: VISION_EVENTS.SOURCE_CONNECTED, describes: 'A Vision source became available', entityType: 'VISION_SOURCE', live: true },
  { type: VISION_EVENTS.SOURCE_DISCONNECTED, describes: 'A Vision source stopped being available', entityType: 'VISION_SOURCE', live: true },
  { type: VISION_EVENTS.SOURCE_DEGRADED, describes: 'A Vision source is available but its quality fell', entityType: 'VISION_SOURCE', live: true },

  { type: VISION_EVENTS.PLAYER_TRACK_OBSERVED, describes: 'A tracked person was observed in a frame', entityType: 'VISION_SESSION', live: false },
  { type: VISION_EVENTS.BALL_OBSERVED, describes: 'The ball was directly detected in a frame', entityType: 'VISION_SESSION', live: false },
  { type: VISION_EVENTS.BALL_PROPAGATED, describes: 'A ball position was carried forward through camera motion, not observed', entityType: 'VISION_SESSION', live: false },

  { type: VISION_EVENTS.CALIBRATION_VALID, describes: 'Metric pitch calibration was accepted for a span of frames', entityType: 'VISION_SESSION', live: true },
  { type: VISION_EVENTS.CALIBRATION_DEGRADED, describes: 'Calibration holds but its expected error widened', entityType: 'VISION_SESSION', live: true },
  { type: VISION_EVENTS.CALIBRATION_NONE, describes: 'No metric calibration; no pitch coordinates may be claimed', entityType: 'VISION_SESSION', live: true },

  { type: VISION_EVENTS.EVENT_CONTROL, describes: 'A player was confirmed in control of the ball on ball evidence', entityType: 'VISION_SESSION', live: true },
  { type: VISION_EVENTS.EVENT_PROXIMITY, describes: 'A player was near the ball. Proximity is not possession', entityType: 'VISION_SESSION', live: true },
  { type: VISION_EVENTS.EVENT_POSSESSION_TRANSITION, describes: 'Confirmed control passed from one player to another', entityType: 'VISION_SESSION', live: true },
];

/**
 * The payload every Vision event carries.
 *
 * Provenance is not optional and is not a nested extra: a Vision claim without
 * the session, source and model that produced it is a claim nobody can check,
 * and an unverifiable claim is the thing this whole module exists to avoid.
 */
export interface VisionEventPayload {
  sessionId: string;
  sourceId: string;
  /** Null for a platform-level session with no club scope yet. */
  clubId: string | null;
  teamId?: string | null;
  /** The engine's own pipeline version, carried so a replay knows what made it. */
  pipelineVersion: string | null;
  /** Registry model ids that produced this claim. */
  modelIds: string[];
  /** MEASURED, PROPAGATED, SYNTHETIC or UNKNOWN — the engine's own word. */
  origin: 'MEASURED' | 'PROPAGATED' | 'SYNTHETIC' | 'UNKNOWN';
  frameNumber?: number | null;
  timestampSeconds?: number | null;
  detail?: Record<string, unknown>;
}

/**
 * One payload shape for every Vision event, validated by the Fabric.
 *
 * One shape rather than seventeen because the fields that matter are the same
 * every time — which session, which source, which models, and whether the claim
 * was measured or carried. What differs between a proximity finding and a
 * calibration verdict belongs in `detail`, where it is data rather than a
 * schema the registry has to learn seventeen versions of.
 */
export const VISION_PAYLOAD_SCHEMA = z.object({
  sessionId: z.string().min(1),
  sourceId: z.string().min(1),
  clubId: z.string().nullable().optional(),
  teamId: z.string().nullable().optional(),
  pipelineVersion: z.string().nullable(),
  modelIds: z.array(z.string()),
  origin: z.enum(['MEASURED', 'PROPAGATED', 'SYNTHETIC', 'UNKNOWN']),
  frameNumber: z.number().nullable().optional(),
  timestampSeconds: z.number().nullable().optional(),
  detail: z.record(z.unknown()).optional(),
});

let registered: FabricEventSpec[] | null = null;

/**
 * Register Vision's names and its payload schema.
 *
 * Idempotent, because the module may be imported from a route, a worker and a
 * test in the same process, and registering twice must not be a way to get two
 * different answers about what a name means.
 */
export function registerVisionEvents(): FabricEventSpec[] {
  if (registered) return registered;
  registered = registerFabricEvents(SPECS.map((s) => ({
    type: s.type,
    describes: s.describes,
    classification: 'INTERNAL' as const,
    schemaVersion: SCHEMA_VERSION,
    source: VISION_SOURCE_ID,
    entityType: s.entityType,
    exposeInLiveStream: s.live,
  })));
  for (const s of SPECS) {
    registerFabricSchema({
      eventType: s.type,
      version: SCHEMA_VERSION,
      describes: s.describes,
      schema: VISION_PAYLOAD_SCHEMA,
    });
  }
  return registered;
}

/** What is registered, for the Integrations screen and for tests. */
export function visionEventCatalogue(): ReadonlyArray<Spec & { schemaVersion: number }> {
  return SPECS.map((s) => ({ ...s, schemaVersion: SCHEMA_VERSION }));
}
