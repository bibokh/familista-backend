// The System and Platform domain, as a Data Fabric producer
// ─────────────────────────────────────────────────────────────────────────────
// ONE SOURCE. The API, the database, Redis, authentication, the workers, the
// deploy pipeline, the integrations and the fabric's own registries are
// COMPONENTS of one source, told apart by the `component` token and never by a
// card of their own.
//
// WHAT THIS FILE REFUSES TO DO
//
// Invent a measurement. There is no CPU figure here, no memory figure, no
// request rate, no error rate, no uptime and no queue depth, because this
// platform measures none of them. A metric that does not exist is reported as
// absent by saying nothing about it — never as a plausible number.
//
// The same discipline applies to DEPLOYMENT, which is the sharpest case in this
// domain and the reason `system.deploy.*` is registered and produced by
// nothing. `deploy.yml` exits successfully without POSTing its hook whenever
// `RENDER_DEPLOY_HOOK_URL` is unset — which it currently is — so a green
// workflow is evidence that a workflow ran and evidence of nothing else.
// Publishing `system.deploy.completed` from it would be the platform telling
// itself a comfortable lie in the one place an operator most needs the truth.
//
// WHAT NEVER TRAVELS
//
// No environment variable VALUE. No key, credential, connection string, token,
// cookie, auth header, deploy hook, SMTP password or session content. No stack
// trace. A configuration event says that configuration MOVED and names the
// setting; it does not say what the setting now is.
//
// THE RECURSION PROBLEM, AND HOW IT IS CLOSED
//
// This producer reports on the publisher it publishes through. Naïvely, a
// failing publisher produces a "publisher is failing" event, whose publication
// fails, which produces another — forever.
//
// Three guards, each independently sufficient, and all three present because
// this is the one failure in the file that would take the process down:
//
//   1. SELF-EXEMPTION. A failure to publish an event whose name begins
//      `system.fabric.` is never reported. The loop cannot start.
//   2. A LATCH. Degraded is published on ENTERING the state, not per failure.
//      A thousand failures are one event.
//   3. RE-ENTRANCY. While a health event is being built, another cannot be.
//
// `tests/fabric-system-producer.unit.test.ts` drives a transport that fails
// every single append and asserts the process publishes exactly one event.

import { z } from 'zod';
import { registerFabricEvent } from '../registry/event-registry';
import { registerFabricSchema } from '../registry/schema-registry';
import { publishFabricEventDetached } from '../registry/publisher';
import type { EventSourceType } from '../event-envelope';

/** The source every event in this file belongs to. Registered in `source-registry`. */
export const SYSTEM_SOURCE_ID = 'system';

const token = (max = 48) => z.string().min(1).max(max).nullable();

/**
 * Which part of the platform this is about.
 *
 * The one field that tells an API event from a database event from a worker
 * event, and the reason none of them needs a source card of its own.
 */
const component = z.enum([
  'API', 'DATABASE', 'CACHE', 'AUTH', 'STORAGE', 'EMAIL',
  'WORKER', 'INTEGRATION', 'DEPLOY', 'CONFIG', 'FABRIC',
]);

/** Which deployment this is. `production`, `development`, `test`. */
const environment = token(24);

/** A health state, as the platform's own `HealthCheckState` records it. */
const healthState = token(24);

/** Why something failed, as one of seven. Never the error itself. */
const failureCategory = z.enum([
  'timeout', 'unavailable', 'validation_error', 'permission_denied',
  'rate_limited', 'dependency_failure', 'internal_error',
]);

const context = { component, environment };

export function registerSystemProducer(): void {
  // ── services ───────────────────────────────────────────────────────────────

  registerFabricEvent({
    type: 'system.service.started',
    describes: 'A platform service or worker began running',
    classification: 'INTERNAL',
    entityType: 'PLATFORM',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'system.service.started', version: 1,
    describes: 'Which service started, and in which environment',
    schema: z.object({ service: token(), ...context }).strict(),
  });

  registerFabricEvent({
    type: 'system.service.stopped',
    describes: 'A platform service or worker stopped running',
    classification: 'INTERNAL',
    entityType: 'PLATFORM',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'system.service.stopped', version: 1,
    describes: 'Which service stopped, and in which environment',
    schema: z.object({ service: token(), ...context }).strict(),
  });

  // ── health ─────────────────────────────────────────────────────────────────

  registerFabricEvent({
    type: 'system.health.changed',
    describes: 'A service’s health state moved',
    classification: 'INTERNAL',
    entityType: 'PLATFORM',
  });
  registerFabricSchema({
    eventType: 'system.health.changed', version: 1,
    // A TRANSITION, never a snapshot. The health endpoint is polled; publishing
    // per poll would put a heartbeat on the board and call it information.
    // `latencyMs` is here because the platform genuinely measures it on a
    // health check and nowhere else in this file.
    describes: 'Which way a service’s health moved. Never the check’s payload',
    schema: z.object({
      service: token(), from: healthState, to: healthState,
      latencyMs: z.number().int().min(0).max(3_600_000).nullable(),
      ...context,
    }).strict(),
  });

  // ── configuration and features ─────────────────────────────────────────────

  registerFabricEvent({
    type: 'system.config.changed',
    describes: 'A platform setting was changed',
    classification: 'INTERNAL',
    entityType: 'PLATFORM',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'system.config.changed', version: 1,
    // THE SETTING, NEVER ITS VALUE. `setting` is a key the platform defines —
    // a feature flag's key, not a secret's name and not a secret's contents.
    describes: 'Which setting moved. Never what it moved to',
    schema: z.object({ setting: token(80), ...context }).strict(),
  });

  for (const [type, describes] of [
    ['system.feature.enabled', 'A feature flag was turned on'],
    ['system.feature.disabled', 'A feature flag was turned off'],
  ] as const) {
    registerFabricEvent({
      type, describes, classification: 'INTERNAL', entityType: 'PLATFORM', auditRelevant: true,
    });
    registerFabricSchema({
      eventType: type, version: 1,
      describes: 'Which flag moved. Never its description or its plan list',
      schema: z.object({ setting: token(80), ...context }).strict(),
    });
  }

  // ── the fabric's own health ────────────────────────────────────────────────

  registerFabricEvent({
    type: 'system.fabric.publisher.degraded',
    describes: 'The fabric publisher began failing to persist events',
    classification: 'INTERNAL',
    entityType: 'PLATFORM',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'system.fabric.publisher.degraded', version: 1,
    describes: 'That appends began failing, in one safe category',
    schema: z.object({ failureCategory, ...context }).strict(),
  });

  registerFabricEvent({
    type: 'system.fabric.publisher.recovered',
    describes: 'The fabric publisher began persisting events again',
    classification: 'INTERNAL',
    entityType: 'PLATFORM',
  });
  registerFabricSchema({
    eventType: 'system.fabric.publisher.recovered', version: 1,
    describes: 'That appends are landing again',
    schema: z.object({ ...context }).strict(),
  });

  registerFabricEvent({
    type: 'system.fabric.registry.degraded',
    describes: 'The fabric registry saw an unregistered name or an invalid payload',
    classification: 'INTERNAL',
    entityType: 'PLATFORM',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'system.fabric.registry.degraded', version: 1,
    // The NAME that was not registered does travel: it is an event type, which
    // is platform vocabulary and the single most useful thing an operator can
    // be told here. The payload that failed its schema does not.
    describes: 'Which kind of registry problem, and the name that caused it',
    schema: z.object({
      problem: z.enum(['UNREGISTERED_TYPE', 'SCHEMA_FAILURE']),
      eventType: token(120),
      ...context,
    }).strict(),
  });

  // ── declared, produced by nothing ──────────────────────────────────────────

  // DEPLOYMENT. See the note at the top of this file: a green `deploy.yml` is
  // not a Render deployment, and nothing in this platform can currently observe
  // one. Registered so the day a Render webhook or API poll exists it registers
  // nothing new; produced by nothing, because a false completion is worse than
  // a missing one.
  for (const [type, describes] of [
    ['system.deploy.started', 'A deployment began'],
    ['system.deploy.completed', 'A deployment finished and is serving'],
    ['system.deploy.failed', 'A deployment did not finish'],
  ] as const) {
    registerFabricEvent({
      type, describes, classification: 'INTERNAL', entityType: 'PLATFORM',
      auditRelevant: true, produced: false,
    });
    registerFabricSchema({
      eventType: type, version: 1,
      describes: 'Which revision, in which environment. Never a hook URL',
      schema: z.object({
        revision: token(64), failureCategory: failureCategory.nullable(), ...context,
      }).strict(),
    });
  }

  // ROUTES AND PAGES. The interface already reports these, through
  // `/api/v1/telemetry/events` into `TelemetryEvent`, which the pulse reads on
  // its own tail. Publishing them through the central publisher as well would
  // record every page view twice and put a render loop on an operational board
  // — exactly the flood §12 forbids. Registered so the vocabulary exists.
  for (const [type, describes] of [
    ['system.route.changed', 'The interface moved to a different route'],
    ['system.module.opened', 'A module was opened in the interface'],
    ['system.page.viewed', 'A page was viewed'],
  ] as const) {
    registerFabricEvent({
      type, describes, classification: 'INTERNAL', entityType: 'PLATFORM', produced: false,
    });
    registerFabricSchema({
      eventType: type, version: 1,
      // A route NAME, never a URL: a query string is where an id, a token or a
      // search term ends up.
      describes: 'Which named surface. Never a URL and never a query string',
      schema: z.object({ surface: token(80), ...context }).strict(),
    });
  }

  // JOBS. The platform's real background work — agent runs, transcodes, video
  // inference — is already published under `ai.*` and `media.*`, by the workers
  // that do it. A generic system job event beside them would be a second name
  // for facts that already have one.
  for (const [type, describes] of [
    ['system.job.started', 'A background job began'],
    ['system.job.completed', 'A background job finished'],
    ['system.job.failed', 'A background job failed'],
  ] as const) {
    registerFabricEvent({
      type, describes, classification: 'INTERNAL', entityType: 'PLATFORM', produced: false,
    });
    registerFabricSchema({
      eventType: type, version: 1,
      describes: 'Which job kind, and how it went',
      schema: z.object({
        job: token(), failureCategory: failureCategory.nullable(), ...context,
      }).strict(),
    });
  }

  // INTEGRATIONS. No connect or disconnect flow exists: the platform's external
  // dependencies are configured by environment and are not connected or
  // disconnected at runtime, so there is no transition to observe.
  for (const [type, describes] of [
    ['system.integration.connected', 'An external integration was connected'],
    ['system.integration.disconnected', 'An external integration was disconnected'],
  ] as const) {
    registerFabricEvent({
      type, describes, classification: 'INTERNAL', entityType: 'PLATFORM',
      auditRelevant: true, produced: false,
    });
    registerFabricSchema({
      eventType: type, version: 1,
      // A provider CATEGORY, never an endpoint — a private URL is where a
      // credential most often hides.
      describes: 'Which integration category. Never an endpoint or a credential',
      schema: z.object({ integration: token(), ...context }).strict(),
    });
  }

  // The registry's counters are cumulative for the life of a process and never
  // decrease, so there is no recovery transition to observe. A restart is the
  // only way back, and a restart publishes `system.service.started`.
  registerFabricEvent({
    type: 'system.fabric.registry.recovered',
    describes: 'The fabric registry stopped seeing problems',
    classification: 'INTERNAL',
    entityType: 'PLATFORM',
    produced: false,
  });
  registerFabricSchema({
    eventType: 'system.fabric.registry.recovered', version: 1,
    describes: 'That the registry is clean again',
    schema: z.object({ ...context }).strict(),
  });
}

registerSystemProducer();

// ── the helpers the platform calls ───────────────────────────────────────────

type Component = z.infer<typeof component>;

/** The deployment this process is. Read from the environment, never its values. */
function env(): string {
  return String(process.env.NODE_ENV ?? 'development').slice(0, 24);
}

export interface SystemContext {
  /** The component instance: a service name, a flag key, `publisher`. */
  entityId: string;
  component: Component;
  clubId?: string | null;
  actorUserId?: string | null;
  correlationId?: string | null;
  sourceType?: EventSourceType;
}

function publish(
  eventType: string,
  ctx: SystemContext,
  extra: Record<string, unknown> = {},
): void {
  publishFabricEventDetached({
    eventType,
    clubId: ctx.clubId ?? null,
    teamId: null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'PLATFORM',
    subjectId: ctx.entityId,
    sourceType: ctx.sourceType ?? 'SERVICE',
    correlationId: ctx.correlationId ?? null,
    payload: { ...extra, component: ctx.component, environment: env() },
  });
}

export function publishSystemServiceStarted(service: string): void {
  publish('system.service.started', { entityId: service, component: 'WORKER' }, { service });
}

export function publishSystemServiceStopped(service: string): void {
  publish('system.service.stopped', { entityId: service, component: 'WORKER' }, { service });
}

/**
 * A service's health moved.
 *
 * Call ONLY on a real transition. The caller compares against the last
 * recorded state; this function does not guess, and publishing a snapshot per
 * poll would make a heartbeat look like news.
 */
export function publishSystemHealthChanged(
  service: string, from: string | null, to: string, latencyMs?: number | null,
): void {
  publish('system.health.changed', { entityId: service, component: 'API' }, {
    service, from: from ?? null, to,
    latencyMs: Number.isFinite(Number(latencyMs)) && Number(latencyMs) >= 0
      ? Math.min(3_600_000, Math.round(Number(latencyMs))) : null,
  });
}

export function publishSystemConfigChanged(
  setting: string, actorUserId?: string | null,
): void {
  publish(
    'system.config.changed',
    { entityId: setting, component: 'CONFIG', actorUserId, sourceType: 'USER' },
    { setting: setting.slice(0, 80) },
  );
}

export function publishSystemFeatureToggled(
  setting: string, enabled: boolean, actorUserId?: string | null,
): void {
  publish(
    enabled ? 'system.feature.enabled' : 'system.feature.disabled',
    { entityId: setting, component: 'CONFIG', actorUserId, sourceType: 'USER' },
    { setting: setting.slice(0, 80) },
  );
}

// ── the fabric reporting on itself, without eating its own tail ──────────────

/** Names this reporter must never report a failure for. See guard 1 above. */
const SELF_PREFIX = 'system.fabric.';

let publisherDegraded = false;
let registryDegraded = false;
let reporting = false;

/**
 * Publish a self-health event, or decline to.
 *
 * Guard 3: while one of these is being built, another cannot be. The flag is
 * released synchronously — `publishFabricEventDetached` returns immediately and
 * never rejects — so a later, genuine transition is not lost.
 */
function report(eventType: string, extra: Record<string, unknown>): void {
  if (reporting) return;
  reporting = true;
  try {
    publish(eventType, { entityId: eventType.split('.')[2] ?? 'fabric', component: 'FABRIC' }, extra);
  } catch {
    // Observability about observability is the last thing allowed to throw.
  } finally {
    reporting = false;
  }
}

/**
 * The publisher landed an event, or did not.
 *
 * Called from the event bus on every append. Cheap on the hot path: a name
 * check and a boolean, and nothing at all while the publisher is healthy.
 */
export function noteFabricPublishOutcome(eventType: string, ok: boolean): void {
  // GUARD 1 — the loop cannot start. A failure to publish a self-health event
  // is never itself reported, so the worst case is one undelivered event
  // rather than an unbounded cascade.
  if (String(eventType ?? '').startsWith(SELF_PREFIX)) return;

  if (ok) {
    if (!publisherDegraded) return;
    publisherDegraded = false;
    report('system.fabric.publisher.recovered', {});
    return;
  }

  // GUARD 2 — a latch. Degraded is a STATE, published on entering it. A
  // thousand consecutive failures are one event, not a thousand.
  if (publisherDegraded) return;
  publisherDegraded = true;
  report('system.fabric.publisher.degraded', { failureCategory: 'dependency_failure' });
}

/**
 * The registry saw something it did not recognise.
 *
 * Latched the same way, and for the same reason: an unregistered name usually
 * arrives in a burst, and a burst is one problem.
 */
export function noteFabricRegistryProblem(
  problem: 'UNREGISTERED_TYPE' | 'SCHEMA_FAILURE', eventType: string,
): void {
  if (String(eventType ?? '').startsWith(SELF_PREFIX)) return;
  if (registryDegraded) return;
  registryDegraded = true;
  report('system.fabric.registry.degraded', {
    problem, eventType: String(eventType ?? '').slice(0, 120) || null,
  });
}

/** Whether the reporter currently believes each half is unwell. For a status surface. */
export function fabricSelfHealth(): { publisherDegraded: boolean; registryDegraded: boolean } {
  return { publisherDegraded, registryDegraded };
}

/** Clear the latches. Tests only. */
export function resetFabricSelfHealth(): void {
  publisherDegraded = false;
  registryDegraded = false;
  reporting = false;
}
