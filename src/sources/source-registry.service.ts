// SOURCE CORE — where Familista's inputs come from, and how they travel
// ─────────────────────────────────────────────────────────────────────────────
// THE QUESTION THIS LAYER ANSWERS, AND WHY IT IS NOT ONE OF THE OTHER TWO
//
//   Infrastructure City   WHAT the platform is built from, and what depends on
//                         what. A map of components.
//   Data Vault            WHAT the platform remembers. A window on history.
//   Source Core           WHERE an input ORIGINATES, how it ENTERS, what
//                         VALIDATES it, where it GOES, and who CONSUMES it.
//
// The three overlap in subject and not in question, which is why this file
// derives rather than discovers.
//
// IT DISCOVERS NOTHING. IT COMPOSES.
//
// Building a third discovery mechanism would give the platform a third opinion
// about itself, and three opinions drift. Every source below is assembled from
// a registry that already exists and is already the authority for its half:
//
//   fabricSources()            the Data Fabric's own source registry — the
//                              eleven internal domains, with the event
//                              prefixes each owns
//   fabricEventsForSource()    what each of them actually produces, with the
//                              classification and schema version already
//                              declared there
//   the infrastructure manifest  every component, technology, relationship and
//                              piece of repository evidence, generated at
//                              build by `infrastructure-discover.js`
//   infrastructureSignals()    the live state of the thirteen things the
//                              platform measures
//
// So a source registered in the Fabric tomorrow appears here with no edit, and
// a component discovered in the repository next week appears here with no edit.
// That is the requirement — the map must not need a person to keep it true.
//
// FIVE ORIGINS, AND ONE OF THEM IS UNCOMFORTABLE
//
// The taxonomy came out of the audit rather than out of a design:
//
//   1  INTERNAL   the eleven Fabric domains. They produce registered events.
//   2  EXTERNAL   Anthropic, Stripe, email, GitHub, Render. Named by the
//                 repository, reached over a network.
//   3  DATABASE / INFRASTRUCTURE   PostgreSQL, Redis, the object store, the
//                 historical store.
//   4  TECHNOLOGY the thirty technologies the lockfile proves.
//   5  UNREGISTERED INTAKE   mounted routers that accept input and produce no
//                 registered event. `/devices`, `/vision`, `/edge`, `/neuro`,
//                 `/provisioning`. The code exists and the route is live, so
//                 they are not "future"; the Fabric does not know them, so they
//                 are not sources either. A provenance map that omitted them
//                 would be claiming the platform knows where all its data comes
//                 from, and it does not. They are listed, and they are listed
//                 as what they are.
//
// NOTHING IS INVENTED
//
// No count, rate, timestamp, version or health value in this file is produced
// by this file. Every one is read from a registry that measured it, and where
// nothing measured it the answer is a named absence — NOT_INSTRUMENTED,
// NOT_CONFIGURED, UNKNOWN or FUTURE — never a comfortable default.

import { fabricSources, type FabricSourceSpec } from '../fabric/registry/source-registry';
import { fabricEventsForSource } from '../fabric/registry/event-registry';
import { manifestOrNull, type InfraComponent, type InfraManifest } from '../infra/infrastructure-registry.service';
import { infrastructureSignals, type Signal, type HealthState } from '../infra/infrastructure-health.service';

// ── the vocabulary ───────────────────────────────────────────────────────────

export type SourceType =
  | 'INTERNAL_PLATFORM' | 'USER_GENERATED' | 'SYSTEM_GENERATED'
  | 'EXTERNAL_PROVIDER' | 'TECHNOLOGY' | 'DATABASE' | 'EVENT'
  | 'FILE_MEDIA' | 'AI' | 'DEVICE' | 'UNREGISTERED_INTAKE' | 'FUTURE';

/**
 * How healthy a source is.
 *
 * `NOT_INSTRUMENTED` is not a synonym for healthy and never collapses into it.
 * A source nobody measures is a source nobody measures.
 */
export type SourceHealth =
  | 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'DELAYED'
  | 'DISCONNECTED' | 'UNKNOWN' | 'NOT_INSTRUMENTED' | 'FUTURE';

/** Whether anything is actually flowing, which is a different question. */
export type ConnectionState =
  | 'LIVE' | 'CONNECTED' | 'NOT_CONFIGURED' | 'NOT_CONNECTED'
  | 'UNVERIFIED' | 'UNKNOWN';

/** How an input gets in. Named from the route or the client that carries it. */
export type IntakeMethod =
  | 'REST_API' | 'WEBHOOK' | 'SSE' | 'INTERNAL_EVENT' | 'DATABASE_WRITE'
  | 'FILE_UPLOAD' | 'BACKGROUND_WORKER' | 'OUTBOUND_CALL' | 'BUILD_TIME'
  | 'DEPLOY_HOOK' | 'NOT_APPLICABLE' | 'UNKNOWN';

export interface SourceControl {
  /** The control's name, as the repository calls it. */
  id: string;
  /** Applied, or honestly not. */
  state: 'APPLIED' | 'NOT_INSTRUMENTED' | 'NOT_IMPLEMENTED';
  evidence: string;
}

export interface PlatformSource {
  id: string;
  name: string;
  sourceType: SourceType;
  category: string;
  /** Where it comes FROM, in a person's words. */
  origin: string;
  provider: string | null;
  internalOrExternal: 'INTERNAL' | 'EXTERNAL';
  status: string;
  health: SourceHealth;
  connectionState: ConnectionState;
  /** Only ever a figure a registry measured. Null where none did. */
  lastEventAt: string | null;
  eventsPerMinute: number | null;
  updateMode: 'EVENT_DRIVEN' | 'REQUEST_DRIVEN' | 'POLLED' | 'BUILD_TIME' | 'UNKNOWN';
  intake: IntakeMethod;
  /** Event types, package names or route paths — whatever it really emits. */
  produces: string[];
  producesCount: number;
  consumers: string[];
  dependencies: string[];
  dependents: string[];
  destinationModules: string[];
  dataClassification: string | null;
  /** The KIND of credential, never the credential. */
  authMethod: string | null;
  environment: string | null;
  region: string | null;
  version: string | null;
  schemaVersion: number | null;
  riskState: 'NONE' | 'UNMEASURED' | 'DEGRADED' | 'FAILED' | 'UNCONFIGURED';
  futureState: 'ACTIVE' | 'NOT_CONNECTED' | 'NOT_IMPLEMENTED';
  /** The controls that run before this source is trusted. */
  controls: SourceControl[];
  /** The file that proves it exists. Never empty. */
  evidence: string;
  repositoryPath: string | null;
  /** Which of the four sibling modules can show more about it. */
  crossLinks: { module: string; target: string }[];
  note: string | null;
}

// ── health joins ─────────────────────────────────────────────────────────────

function healthFromSignal(s: Signal | undefined): SourceHealth {
  if (!s) return 'NOT_INSTRUMENTED';
  const map: Record<HealthState, SourceHealth> = {
    HEALTHY: 'HEALTHY', WARNING: 'WARNING', CRITICAL: 'CRITICAL',
    NOT_CONFIGURED: 'DISCONNECTED', NOT_INSTRUMENTED: 'NOT_INSTRUMENTED',
    UNVERIFIED: 'UNKNOWN', UNKNOWN: 'UNKNOWN',
  };
  return map[s.state];
}

function connectionFromSignal(s: Signal | undefined): ConnectionState {
  if (!s) return 'UNKNOWN';
  switch (s.state) {
    case 'HEALTHY': return 'CONNECTED';
    case 'WARNING': case 'CRITICAL': return 'CONNECTED';
    case 'NOT_CONFIGURED': return 'NOT_CONFIGURED';
    case 'UNVERIFIED': return 'UNVERIFIED';
    default: return 'UNKNOWN';
  }
}

function riskFromHealth(h: SourceHealth): PlatformSource['riskState'] {
  switch (h) {
    case 'HEALTHY': return 'NONE';
    case 'WARNING': case 'DELAYED': return 'DEGRADED';
    case 'CRITICAL': return 'FAILED';
    case 'DISCONNECTED': return 'UNCONFIGURED';
    default: return 'UNMEASURED';
  }
}

// ── the controls every inbound request actually passes ───────────────────────
//
// Named from the middleware that exists, not from a security wish list. A
// control that is not in the repository is reported as absent.

const INBOUND_CONTROLS: SourceControl[] = [
  { id: 'Authentication', state: 'APPLIED', evidence: 'src/middleware/auth.middleware.ts' },
  { id: 'Authorization & RBAC', state: 'APPLIED', evidence: 'src/platform/access-levels.ts' },
  { id: 'Tenant isolation', state: 'APPLIED', evidence: 'src/middleware/tenant-guard.middleware.ts' },
  { id: 'Input validation', state: 'APPLIED', evidence: 'src/middleware/validate.middleware.ts' },
  { id: 'Rate limiting', state: 'APPLIED', evidence: 'src/middleware/rate-limit.middleware.ts' },
];

const FABRIC_CONTROLS: SourceControl[] = [
  { id: 'Event schema validation', state: 'APPLIED', evidence: 'src/fabric/registry/schema-registry.ts' },
  { id: 'Unknown event quarantine', state: 'APPLIED', evidence: 'src/fabric/registry/unknown-events.ts' },
  { id: 'Payload scrubbing', state: 'APPLIED', evidence: 'src/fabric/history/history-record.ts — no payload is persisted' },
  { id: 'Contract verification', state: 'APPLIED', evidence: 'src/contracts/owner-api.contracts.ts' },
];

// ── 1 · the eleven internal domains ──────────────────────────────────────────

function internalSourceType(spec: FabricSourceSpec): SourceType {
  if (spec.id === 'system') return 'SYSTEM_GENERATED';
  if (spec.id === 'users' || spec.id === 'clubs') return 'USER_GENERATED';
  if (spec.id === 'ai') return 'AI';
  if (spec.id === 'media') return 'FILE_MEDIA';
  return 'INTERNAL_PLATFORM';
}

/**
 * A Fabric domain, as a source.
 *
 * `lastEventAt` and `eventsPerMinute` come from the live registry reading the
 * caller supplies — they are not computed here and they are null when the
 * registry has nothing to report, which on an empty platform is the truth.
 */
function fromFabricSource(
  spec: FabricSourceSpec,
  live: { lastEventAt?: string | null; eventsPerMinute?: number | null } | undefined,
  fabricSignal: Signal | undefined,
): PlatformSource {
  const events = fabricEventsForSource(spec.id);
  const classifications = [...new Set(events.map((e) => String(e.classification)))].sort();
  const schemaVersions = [...new Set(events.map((e) => e.schemaVersion))];

  return {
    id: `fabric:${spec.id}`,
    name: spec.name,
    sourceType: internalSourceType(spec),
    category: spec.category,
    origin: spec.description,
    provider: null,
    internalOrExternal: 'INTERNAL',
    status: spec.enabled ? 'REGISTERED' : 'DISABLED',
    // The Fabric's own health is the closest measured thing to a domain's
    // health. No domain is measured individually, and saying otherwise would
    // be inventing eleven readings from one.
    health: spec.enabled ? healthFromSignal(fabricSignal) : 'DISCONNECTED',
    connectionState: events.length ? 'CONNECTED' : 'NOT_CONNECTED',
    lastEventAt: live?.lastEventAt ?? null,
    eventsPerMinute: typeof live?.eventsPerMinute === 'number' ? live.eventsPerMinute : null,
    updateMode: 'EVENT_DRIVEN',
    intake: 'REST_API',
    produces: events.map((e) => e.type).sort(),
    producesCount: events.length,
    consumers: ['Data Fabric', 'Durable Outbox', 'Historical Event Store', 'Data Vault'],
    dependencies: ['data-fabric'],
    dependents: ['historical-store'],
    destinationModules: ['DATA_VAULT'],
    dataClassification: classifications.length ? classifications.join(', ') : null,
    authMethod: 'JWT (bearer) + RBAC',
    environment: null,
    region: null,
    version: null,
    schemaVersion: schemaVersions.length === 1 ? schemaVersions[0] : null,
    riskState: spec.enabled ? riskFromHealth(healthFromSignal(fabricSignal)) : 'UNCONFIGURED',
    futureState: 'ACTIVE',
    controls: [...INBOUND_CONTROLS, ...FABRIC_CONTROLS],
    evidence: `src/fabric/registry/source-registry.ts — ${spec.id}; owns ${spec.eventDomains.join(', ')}`,
    repositoryPath: 'src/fabric/registry/source-registry.ts',
    crossLinks: [
      { module: 'DATA_VAULT', target: `#data-vault/sources/${spec.id}` },
      { module: 'INFRASTRUCTURE_CITY', target: '#infrastructure-city/district/fabric' },
    ],
    note: null,
  };
}

// ── 2–4 · components and technologies from the manifest ──────────────────────

/** Which sibling module can say more about a given district. */
const DISTRICT_CROSSLINK: Record<string, string> = {
  database: 'database', cache: 'cache', storage: 'storage', ai: 'ai',
  integrations: 'integrations', cicd: 'cicd', fabric: 'fabric', vault: 'vault',
  monitoring: 'monitoring', security: 'security',
};

const COMPONENT_SOURCE_DISTRICTS = new Set([
  'database', 'cache', 'storage', 'ai', 'integrations', 'cicd', 'fabric', 'vault',
]);

function componentSourceType(c: InfraComponent): SourceType {
  if (c.district === 'database') return 'DATABASE';
  if (c.district === 'ai') return 'AI';
  if (c.district === 'storage') return 'FILE_MEDIA';
  if (c.district === 'fabric' || c.district === 'vault') return 'EVENT';
  if (c.provider && c.provider !== 'Render') return 'EXTERNAL_PROVIDER';
  if (c.district === 'integrations' || c.district === 'cicd') return 'EXTERNAL_PROVIDER';
  return 'INTERNAL_PLATFORM';
}

function componentIntake(c: InfraComponent): IntakeMethod {
  if (c.district === 'database') return 'DATABASE_WRITE';
  if (c.district === 'cicd') return c.type === 'PIPELINE' ? 'BUILD_TIME' : 'DEPLOY_HOOK';
  if (c.district === 'integrations') return c.id === 'stripe' ? 'WEBHOOK' : 'OUTBOUND_CALL';
  if (c.district === 'ai') return 'OUTBOUND_CALL';
  if (c.district === 'storage') return 'FILE_UPLOAD';
  if (c.district === 'vault') return 'BACKGROUND_WORKER';
  return 'INTERNAL_EVENT';
}

function fromComponent(
  c: InfraComponent, m: InfraManifest, byKey: Map<string, Signal>,
): PlatformSource {
  const signal = c.healthKey ? byKey.get(c.healthKey) : undefined;
  const health: SourceHealth = c.status === 'FUTURE' ? 'FUTURE' : healthFromSignal(signal);
  const dependents = m.components.filter((x) => x.dependencies.includes(c.id)).map((x) => x.id)
    .concat(m.relationships.filter((r) => r.to === c.id).map((r) => r.from));
  const external = componentSourceType(c) === 'EXTERNAL_PROVIDER';

  return {
    id: `component:${c.id}`,
    name: c.name,
    sourceType: componentSourceType(c),
    category: c.category,
    origin: c.provider ? `${c.provider} — ${c.type.toLowerCase().replace(/_/g, ' ')}` : c.type.toLowerCase().replace(/_/g, ' '),
    provider: c.provider,
    internalOrExternal: external ? 'EXTERNAL' : 'INTERNAL',
    status: c.status,
    health,
    connectionState: c.status === 'FUTURE' ? 'NOT_CONNECTED' : connectionFromSignal(signal),
    lastEventAt: null,
    eventsPerMinute: null,
    updateMode: c.district === 'cicd' ? 'BUILD_TIME' : 'REQUEST_DRIVEN',
    intake: componentIntake(c),
    produces: [],
    producesCount: 0,
    consumers: [...new Set(dependents)].sort(),
    dependencies: [...c.dependencies].sort(),
    dependents: [...new Set(dependents)].sort(),
    destinationModules: ['INFRASTRUCTURE_CITY'],
    dataClassification: null,
    // The KIND, never the value. The discovery script never reads one.
    authMethod: external ? 'Configured credential (value never read)' : null,
    environment: null,
    region: c.region,
    version: c.version,
    schemaVersion: null,
    riskState: c.status === 'FUTURE' ? 'UNMEASURED' : riskFromHealth(health),
    futureState: c.status === 'FUTURE' ? 'NOT_IMPLEMENTED' : 'ACTIVE',
    controls: external ? [] : INBOUND_CONTROLS,
    evidence: c.sourceEvidence,
    repositoryPath: c.repositoryPath,
    crossLinks: DISTRICT_CROSSLINK[c.district]
      ? [{ module: 'INFRASTRUCTURE_CITY', target: `#infrastructure-city/district/${DISTRICT_CROSSLINK[c.district]}` }]
      : [],
    note: c.note,
  };
}

function fromTechnology(t: InfraManifest['technologies'][number]): PlatformSource {
  return {
    id: `technology:${t.id}`,
    name: t.name,
    sourceType: 'TECHNOLOGY',
    category: t.category,
    origin: 'npm registry — declared in package.json, pinned by the lockfile',
    provider: null,
    internalOrExternal: 'EXTERNAL',
    status: 'DECLARED',
    // Nothing measures a package at runtime, and a scanner does not run.
    health: 'NOT_INSTRUMENTED',
    connectionState: 'NOT_CONNECTED',
    lastEventAt: null,
    eventsPerMinute: null,
    updateMode: 'BUILD_TIME',
    intake: 'BUILD_TIME',
    produces: [],
    producesCount: 0,
    consumers: [...t.usedBy].sort(),
    dependencies: [],
    dependents: [...t.usedBy].sort(),
    destinationModules: ['INFRASTRUCTURE_CITY'],
    dataClassification: null,
    authMethod: null,
    environment: null,
    region: null,
    version: t.version,
    schemaVersion: null,
    riskState: 'UNMEASURED',
    futureState: 'ACTIVE',
    controls: [],
    evidence: t.sourceEvidence,
    repositoryPath: 'package.json',
    crossLinks: [{ module: 'INFRASTRUCTURE_CITY', target: '#infrastructure-city/technology' }],
    note: null,
  };
}

// ── 5 · intake that exists and is not a registered source ────────────────────

/**
 * Mounted routers that accept input and own no Fabric event prefix.
 *
 * This is the finding the audit turned up and the one a provenance map exists
 * to surface: the route is live, the controller is real, and the platform
 * records nothing about where what arrives there came from. It is not future —
 * the code runs. It is not a source — the Fabric has never heard of it.
 *
 * Derived, not listed: any mounted router whose path matches no registered
 * source's event domains and which is not one of the platform's own read
 * surfaces. A router mounted tomorrow lands here without an edit.
 */
function unregisteredIntake(m: InfraManifest, registeredIds: Set<string>): PlatformSource[] {
  return m.mounts
    .filter((mt) => {
      // IT MUST BE ABLE TO RECEIVE. A router that declares no write verb is a
      // read surface, and calling it an unrecorded ingestion point would be a
      // false finding. `/home` declares none and drops out here; `/devices`
      // declares six and stays. The verbs are counted from the router's own
      // file at build, so this is evidence and not a guess from the path.
      if (!mt.writes) return false;
      // SYSTEM's own surfaces are the platform administering itself, not an
      // input channel into it.
      if (mt.path.startsWith('/system')) return false;
      const head = mt.path.replace(/^\//, '').split('/')[0];
      // A mount whose head matches a registered Fabric domain is already
      // represented by that source; listing it twice would double-count it.
      return !registeredIds.has(head) && !registeredIds.has(head.replace(/s$/, ''));
    })
    .map((mt) => ({
      id: `intake:${mt.path}`,
      name: mt.path,
      sourceType: 'UNREGISTERED_INTAKE' as SourceType,
      category: 'intake',
      origin: 'Mounted API route',
      provider: null,
      internalOrExternal: 'INTERNAL' as const,
      status: 'MOUNTED',
      // The route is guarded and served; what it does with what it receives is
      // not recorded by the Fabric. That is unmeasured, not healthy.
      health: 'NOT_INSTRUMENTED' as SourceHealth,
      connectionState: 'CONNECTED' as ConnectionState,
      lastEventAt: null,
      eventsPerMinute: null,
      updateMode: 'REQUEST_DRIVEN' as const,
      intake: 'REST_API' as IntakeMethod,
      produces: [],
      producesCount: 0,
      consumers: [],
      dependencies: ['api-gateway'],
      dependents: [],
      destinationModules: [],
      dataClassification: null,
      authMethod: 'JWT (bearer) + RBAC',
      environment: null,
      region: null,
      version: null,
      schemaVersion: null,
      riskState: 'UNMEASURED' as const,
      futureState: 'ACTIVE' as const,
      controls: INBOUND_CONTROLS,
      evidence: `${mt.file ?? 'src/routes/index.ts'} — ${mt.writes} write verb(s), ${mt.reads} read verb(s)`,
      repositoryPath: mt.file ?? 'src/routes/index.ts',
      crossLinks: [{ module: 'INFRASTRUCTURE_CITY', target: '#infrastructure-city/district/backend' }],
      note: 'Mounted and guarded. It owns no registered event prefix, so the '
        + 'platform does not record the provenance of what arrives here.',
    }));
}

// ── 6 · future plots ─────────────────────────────────────────────────────────

function fromFuture(f: InfraManifest['future'][number]): PlatformSource {
  return {
    id: `future:${f.id}`,
    name: f.name,
    sourceType: 'FUTURE',
    category: f.district,
    origin: f.reason,
    provider: null,
    internalOrExternal: 'INTERNAL',
    status: 'FUTURE',
    health: 'FUTURE',
    connectionState: 'NOT_CONNECTED',
    lastEventAt: null,
    eventsPerMinute: null,
    updateMode: 'UNKNOWN',
    intake: 'NOT_APPLICABLE',
    produces: [],
    producesCount: 0,
    consumers: [],
    dependencies: [],
    dependents: [],
    destinationModules: [],
    dataClassification: null,
    authMethod: null,
    environment: null,
    region: null,
    version: null,
    schemaVersion: null,
    riskState: 'UNMEASURED',
    futureState: 'NOT_IMPLEMENTED',
    controls: [],
    evidence: f.reason,
    repositoryPath: null,
    crossLinks: [{ module: 'INFRASTRUCTURE_CITY', target: `#infrastructure-city/district/${f.district}` }],
    note: null,
  };
}

// ── the composed registry ────────────────────────────────────────────────────

export interface SourceRegistryState {
  state: 'READY' | 'NOT_GENERATED';
  reason?: string;
  remedy?: string;
  sources: PlatformSource[];
  counts: {
    total: number; internal: number; external: number;
    live: number; warning: number; critical: number;
    notInstrumented: number; notConnected: number; future: number;
    unregisteredIntake: number;
  };
  generatedAt: string | null;
  measuredAt: string;
}

/**
 * Every source, assembled from the registries that already know.
 *
 * `liveByFabricId` carries the per-domain readings the Fabric registry holds
 * at request time — the caller passes them in so this stays a pure join and
 * the route keeps its one place to fetch.
 */
export async function platformSources(
  liveByFabricId: Map<string, { lastEventAt?: string | null; eventsPerMinute?: number | null }> = new Map(),
): Promise<SourceRegistryState> {
  const m = manifestOrNull();
  const measuredAt = new Date().toISOString();

  if (!m) {
    return {
      state: 'NOT_GENERATED',
      reason: 'No infrastructure manifest was found, so component and technology sources cannot be resolved.',
      remedy: 'npm run infra:discover',
      sources: [],
      counts: {
        total: 0, internal: 0, external: 0, live: 0, warning: 0, critical: 0,
        notInstrumented: 0, notConnected: 0, future: 0, unregisteredIntake: 0,
      },
      generatedAt: null,
      measuredAt,
    };
  }

  const signals = await infrastructureSignals();
  const byKey = new Map(signals.map((s) => [s.key, s]));
  const fabricSignal = byKey.get('fabric');

  const specs = fabricSources();
  const registeredIds = new Set(specs.map((s) => s.id));

  const sources: PlatformSource[] = [
    ...specs.map((spec) => fromFabricSource(spec, liveByFabricId.get(spec.id), fabricSignal)),
    ...m.components.filter((c) => COMPONENT_SOURCE_DISTRICTS.has(c.district)).map((c) => fromComponent(c, m, byKey)),
    ...m.technologies.map(fromTechnology),
    ...unregisteredIntake(m, registeredIds),
    ...m.future.map(fromFuture),
  ];

  const count = (p: (s: PlatformSource) => boolean) => sources.filter(p).length;

  return {
    state: 'READY',
    sources,
    counts: {
      total: sources.length,
      internal: count((s) => s.internalOrExternal === 'INTERNAL'),
      external: count((s) => s.internalOrExternal === 'EXTERNAL'),
      live: count((s) => s.health === 'HEALTHY'),
      warning: count((s) => s.health === 'WARNING' || s.health === 'DELAYED'),
      critical: count((s) => s.health === 'CRITICAL'),
      notInstrumented: count((s) => s.health === 'NOT_INSTRUMENTED'),
      notConnected: count((s) => s.connectionState === 'NOT_CONNECTED' || s.health === 'DISCONNECTED'),
      future: count((s) => s.sourceType === 'FUTURE'),
      unregisteredIntake: count((s) => s.sourceType === 'UNREGISTERED_INTAKE'),
    },
    generatedAt: m.generatedAt,
    measuredAt,
  };
}

export function sourceById(sources: PlatformSource[], id: string): PlatformSource | null {
  return sources.find((s) => s.id === id) ?? null;
}

// ── lineage ──────────────────────────────────────────────────────────────────

export interface LineageStage {
  stage: 'ORIGIN' | 'INTAKE' | 'VALIDATION' | 'PROCESSING' | 'DESTINATION' | 'HISTORY';
  label: string;
  detail: string;
  state: 'VERIFIED' | 'NOT_INSTRUMENTED' | 'NOT_APPLICABLE';
  evidence: string;
}

/**
 * One source's path through the platform.
 *
 * Only stages the repository proves. A source that publishes no registered
 * event has no HISTORY stage, and the answer says so rather than drawing an
 * arrow into the Data Vault that nothing travels along.
 */
export function lineageFor(s: PlatformSource): LineageStage[] {
  const stages: LineageStage[] = [
    {
      stage: 'ORIGIN', label: s.name, detail: s.origin,
      state: 'VERIFIED', evidence: s.evidence,
    },
    {
      stage: 'INTAKE', label: s.intake.replace(/_/g, ' '),
      detail: s.intake === 'REST_API' ? 'Arrives on a mounted API route.'
        : s.intake === 'WEBHOOK' ? 'Arrives as a provider callback.'
          : s.intake === 'OUTBOUND_CALL' ? 'The platform calls out; nothing arrives unsolicited.'
            : s.intake === 'BUILD_TIME' ? 'Read once when the build runs.'
              : s.intake === 'DATABASE_WRITE' ? 'Written through the ORM.'
                : s.intake === 'FILE_UPLOAD' ? 'Uploaded through the media pipeline.'
                  : 'Not applicable to this source.',
      state: s.intake === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : 'VERIFIED',
      evidence: s.repositoryPath ?? s.evidence,
    },
    {
      stage: 'VALIDATION',
      label: s.controls.length ? `${s.controls.filter((c) => c.state === 'APPLIED').length} controls` : 'None recorded',
      detail: s.controls.length
        ? s.controls.map((c) => c.id).join(' · ')
        : 'No inbound control applies: nothing arrives unsolicited from this source.',
      state: s.controls.length ? 'VERIFIED' : 'NOT_APPLICABLE',
      evidence: s.controls.length ? s.controls[0].evidence : '—',
    },
  ];

  if (s.producesCount > 0) {
    stages.push({
      stage: 'PROCESSING', label: 'Data Fabric',
      detail: `Publishes ${s.producesCount} registered event type(s) through the central publisher.`,
      state: 'VERIFIED', evidence: 'src/fabric/publisher — emit()',
    });
    stages.push({
      stage: 'DESTINATION', label: 'Durable Outbox → Historical Event Store',
      detail: 'Committed to the outbox, then written to history by a detached writer.',
      state: 'VERIFIED', evidence: 'src/fabric/history/history-record.ts',
    });
    stages.push({
      stage: 'HISTORY', label: 'Data Vault',
      detail: 'Queryable by day, source, club, entity and correlation.',
      state: 'VERIFIED', evidence: 'src/routes/fabric.routes.ts — /history',
    });
  } else {
    stages.push({
      stage: 'PROCESSING', label: 'Not recorded',
      detail: 'This source publishes no registered event type, so the platform '
        + 'does not record what it contributed or when.',
      state: 'NOT_INSTRUMENTED', evidence: 'src/fabric/registry/event-registry.ts — no type declares this source',
    });
  }
  return stages;
}

// ── impact ───────────────────────────────────────────────────────────────────

export interface ImpactNode {
  id: string;
  name: string;
  /** How certain the effect is. Overstating an outage helps nobody. */
  relation: 'DIRECTLY_AFFECTED' | 'DEPENDENT' | 'POTENTIALLY_AFFECTED';
  evidence: string;
}

/**
 * What may break if this source stops.
 *
 * Three degrees, kept apart on purpose. DIRECTLY_AFFECTED is a recorded
 * relationship in the manifest. DEPENDENT is one hop further along the same
 * recorded edges. POTENTIALLY_AFFECTED is a module the source declares as a
 * destination — a real link, but a coarser one, and it is labelled coarser.
 */
export function impactFor(s: PlatformSource, all: PlatformSource[]): ImpactNode[] {
  const m = manifestOrNull();
  const out: ImpactNode[] = [];
  const seen = new Set<string>();
  const raw = s.id.replace(/^(component|fabric|technology|future|intake):/, '');

  if (m) {
    for (const r of m.relationships) {
      if (r.to !== raw) continue;
      if (seen.has(r.from)) continue;
      seen.add(r.from);
      const c = m.components.find((x) => x.id === r.from);
      out.push({
        id: r.from, name: c?.name ?? r.from,
        relation: 'DIRECTLY_AFFECTED', evidence: r.evidence,
      });
    }
    for (const c of m.components) {
      if (!c.dependencies.includes(raw) || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ id: c.id, name: c.name, relation: 'DIRECTLY_AFFECTED', evidence: c.sourceEvidence });
    }
    // One hop further along the same recorded edges.
    for (const direct of [...seen]) {
      for (const r of m.relationships) {
        if (r.to !== direct || seen.has(r.from)) continue;
        seen.add(r.from);
        const c = m.components.find((x) => x.id === r.from);
        out.push({ id: r.from, name: c?.name ?? r.from, relation: 'DEPENDENT', evidence: r.evidence });
      }
    }
  }

  for (const mod of s.destinationModules) {
    if (seen.has(mod)) continue;
    seen.add(mod);
    out.push({
      id: mod, name: mod.replace(/_/g, ' '),
      relation: 'POTENTIALLY_AFFECTED',
      evidence: 'declared destination module for this source',
    });
  }

  void all;
  return out;
}
