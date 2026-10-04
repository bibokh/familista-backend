// The contract between the owner APIs and the screens that read them
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
//
// Infrastructure City shipped with a defect that every test in the repository
// passed through: the inventory endpoint returned districts, components and
// future plots but NOT `relationships`. The backend was correct on its own
// terms, the frontend was correct on its own terms, both compiled, CI was
// green — and three features rendered empty, because the frontend guards each
// read with `|| []` and an absent field is indistinguishable from an empty one.
//
// It was found by looking at a screenshot. That is not a control.
//
// WHAT A CONTRACT IS HERE
//
// One zod schema per endpoint, and the list of paths the frontend actually
// reads off it. The schema is checked in BOTH directions:
//
//   BACKEND   the real app is booted, the endpoint is called, and the response
//             is parsed by the schema. A renamed, removed or retyped field
//             fails here.
//
//   FRONTEND  every path the consumer reads must be a path the schema
//             promises. A frontend that starts reading `dependencies` from a
//             payload carrying `relationships` fails here — which is the
//             defect above, caught before it renders.
//
// Neither direction alone is sufficient, and that is the whole point: the bug
// lived in the gap between two things that were each individually correct.
//
// WHY ZOD, AND WHY NOT A SHARED TYPE
//
// `public/` is plain ES5 JavaScript served as static files. It cannot import a
// TypeScript interface, so a shared interface would constrain exactly one side
// of a two-sided problem — the side that was already right. A runtime schema
// can be executed against a real response AND read as data by a test that
// inspects the other side, which is what makes it a shared source of truth
// rather than a second opinion.
//
// zod is already this repository's validator, in 68 source files. Nothing new
// is introduced here.
//
// WHAT THIS FILE IS NOT
//
// It is not a second definition of the API. The schemas describe what the
// route already returns; where an interface already exists in `src/`, the
// schema is pinned to it by a compile-time check at the bottom of this file,
// so the two cannot drift apart silently.

import { z } from 'zod';
import { CONFIG_VALUES } from '../cyber-defense/control-plane/registry';

// ── shared leaves ────────────────────────────────────────────────────────────

/** An ISO-8601 instant. Tested as parseable, not as a particular spelling. */
export const Instant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'not a parseable ISO-8601 instant',
});

/**
 * Every owner response is `{ success, data }`.
 *
 * Asserted rather than assumed: a route that answered a bare object would
 * break every consumer, and no test looked for it before.
 */
export const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ success: z.literal(true), data });

export const HEALTH_STATES = ['HEALTHY', 'WARNING', 'CRITICAL', 'NOT_CONFIGURED',
  'NOT_INSTRUMENTED', 'UNVERIFIED', 'UNKNOWN'] as const;
export const SEVERITIES = ['CRITICAL', 'WARNING', 'INFO'] as const;
export const INCIDENT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export const COMPONENT_STATUSES = ['ACTIVE', 'NOT_CONFIGURED', 'FUTURE', 'UNKNOWN'] as const;
export const OVERALL_STATES = ['HEALTHY', 'WARNING', 'CRITICAL', 'UNKNOWN'] as const;

// ── Infrastructure City ──────────────────────────────────────────────────────

export const InfraDistrictSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string(),
  zone: z.string(),
  priority: z.number(),
  status: z.string(),
});

export const InfraComponentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  district: z.string().min(1),
  category: z.string(),
  type: z.string(),
  version: z.string().nullable(),
  status: z.enum(COMPONENT_STATUSES),
  runtime: z.string().nullable(),
  provider: z.string().nullable(),
  region: z.string().nullable(),
  repositoryPath: z.string().nullable(),
  sourceEvidence: z.string().min(1),
  dependencies: z.array(z.string()),
  healthKey: z.string().nullable(),
  note: z.string().nullable(),
});

export const InfraRelationshipSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.string().min(1),
  evidence: z.string().min(1),
});

export const InfraFutureSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  district: z.string().min(1),
  reason: z.string().min(1),
});

export const InfraTechnologySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string(),
  version: z.string().nullable(),
  usedBy: z.array(z.string()),
  sourceEvidence: z.string().min(1),
});

export const InfraInventorySchema = z.object({
  state: z.literal('READY'),
  generatedAt: Instant,
  loadedAt: Instant,
  platform: z.object({ name: z.string(), version: z.string() }),
  districts: z.array(InfraDistrictSchema).min(1),
  components: z.array(InfraComponentSchema).min(1),
  // The field whose absence started all this. `.min(1)` rather than a bare
  // array: an empty roads list and a missing one look the same on screen, and
  // this repository has relationships.
  relationships: z.array(InfraRelationshipSchema).min(1),
  future: z.array(InfraFutureSchema),
  // Cyber Defense coverage per component id (R5): the weakest row and the rows.
  coverage: z.record(z.object({
    state: z.enum(['C', 'P', 'U']),
    rows: z.array(z.object({ id: z.number().int().positive(), coverage: z.enum(['C', 'P', 'U']) })).min(1),
  })),
  counts: z.record(z.number()),
  surface: z.record(z.number()),
  database: z.object({
    provider: z.string(),
    models: z.number(),
    enums: z.number(),
    migrations: z.number(),
    latestMigration: z.string().nullable(),
  }),
  typescript: z.record(z.unknown()).nullable(),
  deployment: z.object({
    provider: z.string(),
    services: z.array(z.object({
      name: z.string(),
      type: z.string(),
      runtime: z.string().nullable(),
      region: z.string().nullable(),
      plan: z.string().nullable(),
      autoDeploy: z.boolean().nullable(),
      healthCheckPath: z.string().nullable(),
    })),
    observable: z.boolean(),
    observabilityNote: z.string().min(1),
  }),
  ci: z.object({ workflows: z.array(z.object({
    file: z.string(), name: z.string(), jobs: z.number(),
    steps: z.array(z.string()), services: z.array(z.string()), runsOn: z.array(z.string()),
  })) }),
  environment: z.object({
    total: z.number(),
    architectural: z.array(z.string()),
    secretShapedCount: z.number(),
  }).strict(),                       // strict: a `values` key must never appear
  evidence: z.object({ filesRead: z.array(z.string()).min(1) }),
  layout: z.object({
    zones: z.array(z.object({
      zone: z.string(),
      districts: z.array(z.object({
        id: z.string(), name: z.string(), priority: z.number(),
        components: z.number(), future: z.number(),
      })),
    })),
  }),
});

export const InfraSignalSchema = z.object({
  key: z.string().min(1),
  state: z.enum(HEALTH_STATES),
  summary: z.string(),
  measurements: z.record(z.union([z.number(), z.string(), z.boolean(), z.null()])),
  evidence: z.string().min(1),
  measuredAt: Instant,
});

export const InfraIncidentSchema = z.object({
  id: z.string().min(1),
  ruleId: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(SEVERITIES),
  componentId: z.string().min(1),
  districtId: z.string().min(1),
  status: z.enum(INCIDENT_STATUSES),
  detectedAt: Instant,
  updatedAt: Instant,
  resolvedAt: Instant.nullable(),
  acknowledgedAt: Instant.nullable(),
  occurrences: z.number().int().positive(),
  evidence: z.record(z.unknown()),
  summary: z.string(),
  impact: z.string().min(1),
  nextStep: z.string().min(1),
});

export const InfraHealthSchema = z.object({
  overall: z.enum(OVERALL_STATES),
  signals: z.array(InfraSignalSchema).min(1),
  incidents: z.array(InfraIncidentSchema),
  resolved: z.array(InfraIncidentSchema),
  counts: z.object({
    critical: z.number(), warning: z.number(), info: z.number(),
    healthy: z.number(), notInstrumented: z.number(),
  }),
  thresholds: z.record(z.number()),
  scope: z.literal('PROCESS'),
  measuredAt: Instant,
});

export const InfraTopologySchema = z.object({
  nodes: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    district: z.string(),
    category: z.string(),
    type: z.string(),
    status: z.enum(COMPONENT_STATUSES),
    version: z.string().nullable(),
    provider: z.string().nullable(),
    region: z.string().nullable(),
    health: z.enum(HEALTH_STATES),
    dependencies: z.array(z.string()),
    dependents: z.array(z.string()),
  })).min(1),
  edges: z.array(InfraRelationshipSchema).min(1),
  districts: z.array(InfraDistrictSchema).min(1),
  future: z.array(InfraFutureSchema),
});

export const InfraRuleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(SEVERITIES),
  componentId: z.string().min(1),
  districtId: z.string().min(1),
  condition: z.string().min(1),
  nextStep: z.string().min(1),
  impact: z.string().min(1),
});

export const InfraIncidentsSchema = z.object({
  open: z.array(InfraIncidentSchema),
  resolved: z.array(InfraIncidentSchema),
  rules: z.array(InfraRuleSchema).min(1),
  thresholds: z.record(z.number()),
  scope: z.literal('PROCESS'),
  scopeNote: z.string().min(1),
});

const Instrumentation = z.object({
  state: z.enum(['NOT_INSTRUMENTED', 'NOT_CONFIGURED', 'UNVERIFIED', 'UNKNOWN', 'HEALTHY']),
  note: z.string().min(1),
  evidence: z.string().min(1),
});

export const InfraTechnologyMapSchema = z.object({
  technologies: z.array(InfraTechnologySchema.extend({
    usage: z.object({ districts: z.array(z.string()), components: z.array(z.string()) }),
  })).min(1),
  dependencies: z.array(z.object({
    name: z.string().min(1),
    declared: z.string(),
    resolved: z.string().nullable(),
    classification: z.string(),
    technology: z.string().nullable(),
  })).min(1),
  vulnerabilityScanning: Instrumentation,
  lint: Instrumentation,
  coverage: Instrumentation,
});

export const InfraChangesSchema = z.object({
  changes: z.array(z.record(z.unknown())),
  window: z.object({ from: Instant, to: Instant }),
  source: z.literal('Historical Event Store'),
  build: z.object({
    manifestGeneratedAt: Instant,
    platformVersion: z.string(),
    latestMigration: z.string().nullable(),
  }).nullable(),
  deployment: z.object({ state: z.literal('UNVERIFIED'), note: z.string().min(1) }),
});

export const InfraComponentDetailSchema = z.object({
  component: InfraComponentSchema,
  health: InfraSignalSchema.nullable(),
  dependencies: z.array(InfraComponentSchema),
  dependents: z.array(InfraComponentSchema),
  incidents: z.array(InfraIncidentSchema),
  rules: z.array(InfraRuleSchema),
});

/**
 * The SSE frame the dashboard reads.
 *
 * The stream carries a full health frame under the event name `health`, so the
 * frame contract IS the health contract. Saying so here rather than
 * duplicating it is the point: a change to one cannot leave the other behind.
 */
export const InfraStreamFrameSchema = InfraHealthSchema;
export const INFRA_STREAM_EVENT = 'health';

// ── Data Vault ───────────────────────────────────────────────────────────────

export const VaultHistoryHealthSchema = z.object({
  window: z.object({
    earliest: Instant.nullable(),
    latest: Instant.nullable(),
    total: z.number(),
  }),
  writer: z.object({
    state: z.string(),
    written: z.number(), failures: z.number(), dropped: z.number(),
    duplicates: z.number(), retryBacklog: z.number(),
    lastWriteAt: Instant.nullable(), lastError: z.string().nullable(),
    scope: z.string(),
  }),
  delivery: z.object({
    enabled: z.boolean(),
    pending: z.object({ pending: z.number(), examined: z.number() }).passthrough(),
    lastSweep: z.object({
      examined: z.number(), recovered: z.number(), alreadyPresent: z.number(),
      failed: z.number(), skipped: z.number(),
    }),
    lastSweepAt: Instant.nullable(),
    lookbackMs: z.number(), sweepMs: z.number(), totalRecovered: z.number(),
    scope: z.string(),
  }),
  archive: z.object({
    state: z.string(),
    enabled: z.boolean(),
    bucket: z.string().nullable(),
    missing: z.array(z.string()),
    format: z.string(),
    partitioning: z.string(),
    lastBatch: z.unknown().nullable(),
    objectStore: z.object({ port: z.string(), provider: z.string() }),
  }),
  retention: z.object({
    classes: z.array(z.string()).min(1),
    policyConfigured: z.boolean(),
    note: z.string().min(1),
  }),
});

export const VaultStatsSchema = z.object({
  total: z.number(), today: z.number(), month: z.number(), year: z.number(),
  window: z.object({ earliest: Instant.nullable(), latest: Instant.nullable() }),
  sources: z.array(z.object({
    source: z.string().min(1),
    name: z.string().min(1),
    icon: z.string(),
    category: z.string(),
    total: z.number(), today: z.number(),
    earliest: Instant.nullable(), latest: Instant.nullable(),
    registeredEventTypes: z.number(), producedEventTypes: z.number(),
  })).min(1),
  unregisteredSources: z.array(z.unknown()),
  generatedAt: Instant,
});

/**
 * The page core, shared by the query and the replay.
 *
 * Cursor pagination: `nextCursor` null means the window is exhausted, a string
 * means ask again with it. A change to either shape silently breaks paging —
 * the consumer keeps asking with a value the server no longer understands —
 * so both are pinned.
 */
export const VaultHistoryPageSchema = z.object({
  rows: z.array(z.record(z.unknown())),
  nextCursor: z.string().nullable(),
  more: z.boolean(),
});

/**
 * `GET /history` adds the page ceiling; `GET /history/replay` does not.
 *
 * Found by this contract layer on its first run, which is the point of it: the
 * two endpoints look interchangeable, read almost identically, and differ.
 * Modelling them as one shape would have made the contract wrong rather than
 * making the API right.
 */
export const VaultHistoryQuerySchema = VaultHistoryPageSchema.extend({
  maxPageSize: z.number().int().positive(),
});

export const VaultReplaySchema = VaultHistoryPageSchema.extend({
  readOnly: z.literal(true),
  sideEffects: z.literal('NONE'),
});

export const VaultEntityTypesSchema = z.object({
  entityTypes: z.array(z.unknown()),
});

export const FabricSourcesSchema = z.object({
  sources: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    icon: z.string(),
    category: z.string(),
    domain: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    order: z.number(),
    status: z.string(),
    registeredEventTypes: z.number(),
    eventsPerMinute: z.number(),
    lastEventAt: Instant.nullable(),
    showInLiveDataFlow: z.boolean(),
    eventDomains: z.array(z.string()),
  })).min(1),
  health: z.object({
    unknownEventCount: z.number(),
    unknownEventTypes: z.array(z.unknown()),
    schemaFailureCount: z.number(),
    schemaFailureTypes: z.array(z.unknown()),
    quarantinedCount: z.number(),
  }),
});

// ── SYSTEM ───────────────────────────────────────────────────────────────────

/**
 * A SYSTEM metric.
 *
 * `value: null` with a `source` of NOT_INSTRUMENTED is a first-class answer and
 * must never be coerced to zero — the distinction is the whole reason the
 * `source` field exists, so the schema keeps them apart.
 */
export const MetricSchema = z.object({
  value: z.number().nullable(),
  source: z.enum(['LIVE', 'DERIVED', 'NOT_INSTRUMENTED']),
  how: z.string().min(1),
  unavailable: z.string().optional(),
});

export const SystemOverviewSchema = z.object({
  access: z.record(MetricSchema),
  activity: z.record(MetricSchema),
}).passthrough();

// ── Source Core ──────────────────────────────────────────────────────────────
//
// The provenance layer. Every schema here is pinned to the interface in
// `src/sources/source-registry.service.ts` at the bottom of this file, so a
// field renamed there fails the build rather than emptying a panel.

export const SourceControlSchema = z.object({
  id: z.string().min(1),
  state: z.enum(['APPLIED', 'NOT_INSTRUMENTED', 'NOT_IMPLEMENTED']),
  evidence: z.string().min(1),
});

export const PlatformSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sourceType: z.enum([
    'INTERNAL_PLATFORM', 'USER_GENERATED', 'SYSTEM_GENERATED', 'EXTERNAL_PROVIDER',
    'TECHNOLOGY', 'DATABASE', 'EVENT', 'FILE_MEDIA', 'AI', 'DEVICE',
    'UNREGISTERED_INTAKE', 'FUTURE',
  ]),
  category: z.string(),
  origin: z.string().min(1),
  provider: z.string().nullable(),
  internalOrExternal: z.enum(['INTERNAL', 'EXTERNAL']),
  status: z.string(),
  health: z.enum(['HEALTHY', 'WARNING', 'CRITICAL', 'DELAYED', 'DISCONNECTED',
    'UNKNOWN', 'NOT_INSTRUMENTED', 'FUTURE']),
  connectionState: z.enum(['LIVE', 'CONNECTED', 'NOT_CONFIGURED', 'NOT_CONNECTED',
    'UNVERIFIED', 'UNKNOWN']),
  // Null is the answer when nothing measured it, and the schema says so rather
  // than letting a zero stand in for a reading that was never taken.
  lastEventAt: z.string().nullable(),
  eventsPerMinute: z.number().nullable(),
  updateMode: z.enum(['EVENT_DRIVEN', 'REQUEST_DRIVEN', 'POLLED', 'BUILD_TIME', 'UNKNOWN']),
  intake: z.enum(['REST_API', 'WEBHOOK', 'SSE', 'INTERNAL_EVENT', 'DATABASE_WRITE',
    'FILE_UPLOAD', 'BACKGROUND_WORKER', 'OUTBOUND_CALL', 'BUILD_TIME',
    'DEPLOY_HOOK', 'NOT_APPLICABLE', 'UNKNOWN']),
  produces: z.array(z.string()),
  producesCount: z.number(),
  consumers: z.array(z.string()),
  dependencies: z.array(z.string()),
  dependents: z.array(z.string()),
  destinationModules: z.array(z.string()),
  dataClassification: z.string().nullable(),
  authMethod: z.string().nullable(),
  environment: z.string().nullable(),
  region: z.string().nullable(),
  version: z.string().nullable(),
  schemaVersion: z.number().nullable(),
  riskState: z.enum(['NONE', 'UNMEASURED', 'DEGRADED', 'FAILED', 'UNCONFIGURED']),
  futureState: z.enum(['ACTIVE', 'NOT_CONNECTED', 'NOT_IMPLEMENTED']),
  controls: z.array(SourceControlSchema),
  evidence: z.string().min(1),
  repositoryPath: z.string().nullable(),
  crossLinks: z.array(z.object({ module: z.string(), target: z.string() })),
  note: z.string().nullable(),
});

export const SourceCountsSchema = z.object({
  total: z.number(), internal: z.number(), external: z.number(),
  live: z.number(), warning: z.number(), critical: z.number(),
  notInstrumented: z.number(), notConnected: z.number(), future: z.number(),
  unregisteredIntake: z.number(),
});

export const SourceRegistrySchema = z.object({
  state: z.enum(['READY', 'NOT_GENERATED']),
  reason: z.string().optional(),
  remedy: z.string().optional(),
  sources: z.array(PlatformSourceSchema),
  counts: SourceCountsSchema,
  generatedAt: z.string().nullable(),
  measuredAt: Instant,
});

export const SourceHealthSchema = z.object({
  counts: SourceCountsSchema,
  overall: z.enum(['CRITICAL', 'WARNING', 'HEALTHY', 'UNKNOWN']),
  measuredNote: z.string().min(1),
  measuredAt: Instant,
  generatedAt: z.string().nullable(),
});

export const SourceFlowSchema = z.object({
  origins: z.record(z.array(PlatformSourceSchema)),
  intake: z.record(z.number()),
  validation: z.array(SourceControlSchema),
  consumers: z.array(z.string()),
  counts: SourceCountsSchema,
  measuredAt: Instant,
});

export const SourceDetailSchema = z.object({ source: PlatformSourceSchema });

export const SourceConsumersSchema = z.object({
  consumers: z.array(z.string()),
  destinationModules: z.array(z.string()),
  impact: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    relation: z.enum(['DIRECTLY_AFFECTED', 'DEPENDENT', 'POTENTIALLY_AFFECTED']),
    evidence: z.string().min(1),
  })),
  impactNote: z.string().min(1),
});

export const SourceLineageSchema = z.object({
  source: z.object({
    id: z.string().min(1), name: z.string().min(1), sourceType: z.string().min(1),
  }),
  stages: z.array(z.object({
    stage: z.enum(['ORIGIN', 'INTAKE', 'VALIDATION', 'PROCESSING', 'DESTINATION', 'HISTORY']),
    label: z.string().min(1),
    detail: z.string().min(1),
    state: z.enum(['VERIFIED', 'NOT_INSTRUMENTED', 'NOT_APPLICABLE']),
    evidence: z.string().min(1),
  })),
});

// ── Cybersecurity Command Center ─────────────────────────────────────────────
//
// Every object below is STRICT. This is the one owner surface whose whole job
// is security evidence, so a field the contract does not name must not travel:
// a key, a token, an address or an id added to a view by mistake fails CI here
// before it reaches a screen.

export const PROTECTION_STATES = ['PROTECTED', 'PARTIAL', 'OBSERVING', 'AT_RISK', 'UNKNOWN'] as const;
export const LIVE_STATES = ['LIVE', 'WARNING', 'NOT_INSTRUMENTED', 'NOT_APPLICABLE', 'UNAVAILABLE'] as const;
const Protection = z.enum(PROTECTION_STATES);
const Live = z.enum(LIVE_STATES);
const ControlStatus = z.enum(['PRESENT', 'PARTIAL', 'ABSENT', 'MISSING']);
const Count = z.number().int().nonnegative();
const MaybeCount = Count.nullable();

export const SecFigureSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  kind: z.enum(['count', 'flag', 'instant', 'hours', 'text']),
  source: z.enum(['build', 'runtime', 'process']),
  why: z.string().nullable(),
}).strict();

export const SecConfigItemSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.enum(CONFIG_VALUES),
}).strict();

export const SecWarningSchema = z.object({ key: z.string().min(1), text: z.string().min(1) }).strict();

export const SecControlSchema = z.object({
  id: z.string().min(1),
  status: ControlStatus,
  required: z.boolean(),
  knownGap: z.string().nullable(),
  evidence: z.string().nullable(),
  note: z.string().nullable(),
}).strict();

export const SecRowSchema = z.object({
  id: Count,
  name: z.string(),
  coverage: z.enum(['C', 'P', 'U']),
  boundaryType: z.string(),
  flow: z.string(),
  owner: z.string(),
  dataClass: z.string(),
  controls: z.array(z.string()),
  reason: z.string().nullable(),
  plannedIn: z.string().nullable(),
}).strict();

export const SecSignalTypeSchema = z.object({
  type: z.string().min(1),
  category: z.string(),
  describes: z.string(),
  produced: z.boolean(),
  count24h: MaybeCount,
  count7d: MaybeCount,
}).strict();

const SecKindCountSchema = z.object({
  kind: z.string().min(1),
  label: z.string().min(1),
  count24h: MaybeCount,
  count7d: MaybeCount,
  critical24h: MaybeCount,
}).strict();

export const SecDomainEventsSchema = z.object({
  state: Live,
  kinds: z.array(SecKindCountSchema),
  signals: z.array(SecSignalTypeSchema),
  total24h: MaybeCount,
  total7d: MaybeCount,
  why: z.string().nullable(),
}).strict();

export const SecDomainSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  protects: z.string().min(1),
  state: Protection,
  protection: Protection,
  live: Live,
  liveWhy: z.string().nullable(),
  rows: z.array(Count),
  controls: z.object({ total: Count, present: Count, partial: Count, absent: Count }).strict(),
  figures: z.array(SecFigureSchema),
  config: z.array(SecConfigItemSchema),
  warnings: z.array(SecWarningSchema),
  events: SecDomainEventsSchema,
  areas: z.array(z.string()),
}).strict();

const RecentState = z.enum(['READ', 'UNAVAILABLE', 'NOT_INSTRUMENTED']);

export const SecDomainDetailSchema = SecDomainSummarySchema.extend({
  controlList: z.array(SecControlSchema),
  rowList: z.array(SecRowSchema),
  recentEvents: z.object({
    state: RecentState,
    items: z.array(z.object({ kind: z.string(), label: z.string(), severity: z.string(), at: Instant }).strict()),
    why: z.string().nullable(),
  }).strict(),
  recentSignals: z.object({
    state: RecentState,
    items: z.array(z.object({ type: z.string(), at: Instant }).strict()),
    why: z.string().nullable(),
  }).strict(),
}).strict();

export const SecAreaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  group: z.enum(['PLATFORM', 'DATA', 'INTERFACES', 'AI', 'VISION_DEVICES', 'FOOTBALL', 'OPERATIONS']),
  state: Protection,
  rows: z.array(Count),
  gaps: z.array(SecRowSchema),
  domains: z.array(z.string()),
  routers: z.array(z.string()),
  api: z.object({
    routers: Count, handlers: Count, publicHandlers: Count, routerWideAuth: Count,
    authz: z.record(z.string(), Count),
    tenancy: z.object({ guarded: Count, exempt: Count, unguarded: Count }).strict(),
  }).strict().nullable(),
  note: z.string().nullable(),
}).strict();

export const SecStageSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  describes: z.string().min(1),
  state: z.enum([...PROTECTION_STATES, 'NOT_INSTRUMENTED', 'INFO']),
  controls: z.array(z.object({ id: z.string(), status: ControlStatus }).strict()),
  figures: z.array(SecFigureSchema),
  outsideView: z.string().nullable(),
}).strict();

export const SecRlsSchema = z.object({
  state: Protection,
  mode: z.enum(['off', 'observe', 'on']),
  enforced: z.boolean().nullable(),
  stage: z.object({ index: Count, id: z.string(), title: z.string(), describes: z.string() }).strict(),
  stages: z.array(z.object({
    id: z.string(), title: z.string(), describes: z.string(), reached: z.boolean(), current: z.boolean(),
  }).strict()),
  tables: z.array(z.string()),
  unprotected: z.array(z.string()).nullable(),
  systemPaths: z.array(z.object({ reason: z.string(), review: z.string() }).strict()),
  observations: z.array(z.object({ model: z.string(), operation: z.string(), firstSeenAt: Instant }).strict()),
  windowStart: Instant,
  warnings: z.array(SecWarningSchema),
}).strict();

export const SecEventsOverviewSchema = z.object({
  state: Live,
  why: z.string().nullable(),
  total24h: MaybeCount,
  total7d: MaybeCount,
  critical24h: MaybeCount,
  warning24h: MaybeCount,
  kinds: z.array(SecKindCountSchema),
  signals: z.array(SecSignalTypeSchema),
  alerts: z.object({ dispatcherRunning: z.boolean(), recipientConfigured: z.boolean() }).strict(),
}).strict();

export const SecPostureSchema = z.object({
  verdict: Protection,
  boundaries: z.object({ total: Count, C: Count, P: Count, U: Count }).strict(),
  controls: z.object({ total: Count, present: Count, partial: Count, absent: Count }).strict(),
  required: z.object({ total: Count, present: Count }).strict(),
  knownGaps: z.array(z.object({ id: z.string(), status: ControlStatus, text: z.string() }).strict()),
  domains: z.object({ PROTECTED: Count, PARTIAL: Count, OBSERVING: Count, AT_RISK: Count, UNKNOWN: Count }).strict(),
  generatedAt: Instant,
  generator: z.string(),
}).strict();

export const CommandCenterSchema = z.object({
  state: z.enum(['READY', 'NOT_GENERATED']),
  reason: z.string().nullable(),
  generatedAt: Instant.nullable(),
  measuredAt: Instant,
  instance: z.object({ startedAt: Instant, uptimeHours: Count }).strict(),
  posture: SecPostureSchema.nullable(),
  groups: z.array(z.object({
    id: z.enum(['PLATFORM', 'DATA', 'INTERFACES', 'AI', 'VISION_DEVICES', 'FOOTBALL', 'OPERATIONS']),
    title: z.string().min(1),
  }).strict()),
  domains: z.array(SecDomainSummarySchema),
  areas: z.array(SecAreaSchema),
  lifecycle: z.array(SecStageSchema),
  boundaries: z.array(SecRowSchema),
  rls: SecRlsSchema.nullable(),
  events: SecEventsOverviewSchema,
  unassignedRouters: z.array(z.string()),
}).strict();

// ── Algorithms ───────────────────────────────────────────────────────────────

const LoopStageEnum = z.enum(['OBSERVE', 'LEARN', 'PROPOSE', 'SIMULATE', 'TEST', 'HUMAN_APPROVAL', 'DEPLOY', 'MEASURE']);
const GateEnum = z.enum(['APPROVED', 'NO_APPROVAL', 'VERSION_NOT_APPROVED', 'CHANGED_SINCE_APPROVAL',
  'FINGERPRINT_UNAVAILABLE', 'EVALUATION_FAILED', 'MODE_NOT_ALLOWED']);
const EvalState = z.enum(['PASS', 'FAIL', 'NOT_SIMULATED']);
const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);

export const AlgSummarySchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  domain: z.string().min(1),
  version: z.string().min(1),
  mode: z.string().min(1),
  stage: LoopStageEnum,
  gate: GateEnum,
  evaluation: z.object({ state: EvalState, passed: Count, total: Count }).strict(),
  approval: z.object({ kind: z.enum(['BASELINE', 'CHANGE']), version: z.string().min(1) }).strict().nullable(),
}).strict();

export const AlgorithmsOverviewSchema = z.object({
  state: z.enum(['READY', 'NOT_GENERATED']),
  reason: z.string().nullable(),
  measuredAt: Instant,
  mode: z.literal('READ_ANALYZE'),
  loop: z.array(z.object({
    id: LoopStageEnum,
    title: z.string().min(1),
    describes: z.string().min(1),
    who: z.enum(['PLATFORM', 'HUMAN']),
    next: z.array(LoopStageEnum),
    algorithms: Count,
  }).strict()),
  domains: z.array(z.object({
    id: z.string().min(1), title: z.string().min(1), describes: z.string().min(1), algorithms: Count,
  }).strict()),
  algorithms: z.array(AlgSummarySchema),
  guarantees: z.array(z.object({
    id: z.string().min(1), basis: z.enum(['RUNTIME', 'BUILD']), text: z.string().min(1), holds: z.boolean(),
  }).strict()),
  totals: z.object({
    registered: Count, approved: Count, awaitingApproval: Count, failing: Count,
    simulated: Count, checks: Count, checksPassed: Count,
  }).strict().nullable(),
  monitoring: z.object({
    evaluationRuns: Count, failingRuns: Count, lastRunAt: Instant.nullable(),
    lastDurationMs: z.number().nonnegative().nullable(), refreshSeconds: Count,
  }).strict().nullable(),
}).strict();

const Port = z.object({ name: z.string().min(1), unit: z.string() }).strict();

export const AlgDetailSchema = AlgSummarySchema.extend({
  summary: z.string().min(1),
  usedBy: z.array(z.string().min(1)),
  inputs: z.array(Port),
  outputs: z.array(Port),
  dependsOn: z.array(z.string().min(1)),
  source: z.object({
    file: z.string().min(1), symbols: z.array(z.string().min(1)),
    error: z.string().nullable(), missing: z.array(z.string()),
  }).strict(),
  fingerprint: z.object({ current: Fingerprint.nullable(), approved: Fingerprint.nullable(), matches: z.boolean() }).strict(),
  approval: z.object({
    kind: z.enum(['BASELINE', 'CHANGE']), version: z.string().min(1), approvedBy: z.literal('PLATFORM_OWNER'),
    reference: z.string().min(1), approvedAt: z.string().min(1),
  }).strict().nullable(),
  versions: z.array(z.object({ version: z.string().min(1), date: z.string().min(1), note: z.string().min(1) }).strict()),
  tests: z.array(z.string().min(1)),
  notSimulatedBecause: z.string().nullable(),
  scenarios: z.array(z.object({
    id: z.string().min(1), title: z.string().min(1), pass: z.boolean(),
    checks: z.array(z.object({ label: z.string().min(1), pass: z.boolean(), observed: z.string(), expected: z.string() }).strict()),
  }).strict()),
}).strict();

// ── the registry ─────────────────────────────────────────────────────────────

export interface ApiContract {
  /** The path under /api/v1, exactly as the frontend calls it. */
  endpoint: string;
  /** Query string appended when the contract needs one to be meaningful. */
  query?: string;
  /** Which product this belongs to, for the failure message. */
  module: string;
  /** The schema for the `data` member of the envelope. */
  schema: z.ZodTypeAny;
  /**
   * The file that reads this payload, or null when nothing reads it yet.
   *
   * `null` is a real answer and not a gap in the contract. Two Infrastructure
   * City endpoints are served, guarded and correct, and no screen calls them:
   * the City assembles its topology and its inspector from the INVENTORY
   * payload instead. Recording that is worth more than inventing a consumer,
   * and it is the same overlap that produced the `relationships` defect — the
   * data was available on two endpoints and the frontend read the one that was
   * not sending it.
   */
  consumer: string | null;
  /**
   * The paths the consumer reads off `data`, dotted, arrays elided.
   *
   * Declared rather than only inferred, because a declaration can be asserted
   * from BOTH sides: the schema must promise each one, and the consumer source
   * must actually contain each one. A path that rots fails rather than lying.
   */
  reads: string[];
}

export const OWNER_API_CONTRACTS: ApiContract[] = [
  // ── Infrastructure City ──
  {
    endpoint: '/system/infrastructure', module: 'Infrastructure City',
    schema: InfraInventorySchema, consumer: 'public/infrastructure-city/infrastructure-city.js',
    reads: ['state', 'districts', 'components', 'relationships', 'future', 'layout', 'coverage'],
  },
  {
    endpoint: '/system/infrastructure/health', module: 'Infrastructure City',
    schema: InfraHealthSchema, consumer: 'public/infrastructure-city/infrastructure-city.js',
    reads: ['overall', 'signals', 'incidents', 'resolved', 'counts'],
  },
  {
    endpoint: '/system/infrastructure/topology', module: 'Infrastructure City',
    schema: InfraTopologySchema, consumer: null,
    reads: [],
  },
  {
    endpoint: '/system/infrastructure/incidents', module: 'Infrastructure City',
    schema: InfraIncidentsSchema, consumer: 'public/infrastructure-city/infrastructure-city.js',
    reads: ['rules', 'resolved'],
  },
  {
    endpoint: '/system/infrastructure/technology', module: 'Infrastructure City',
    schema: InfraTechnologyMapSchema, consumer: 'public/infrastructure-city/infrastructure-city.js',
    reads: ['technologies', 'dependencies', 'vulnerabilityScanning', 'lint', 'coverage'],
  },
  {
    endpoint: '/system/infrastructure/changes', module: 'Infrastructure City',
    schema: InfraChangesSchema, consumer: 'public/infrastructure-city/infrastructure-city.js',
    reads: ['changes', 'build', 'deployment'],
  },
  {
    endpoint: '/system/infrastructure/components/postgres', module: 'Infrastructure City',
    schema: InfraComponentDetailSchema, consumer: null,
    reads: [],
  },

  // ── Data Vault ──
  {
    endpoint: '/system/fabric/history/health', module: 'Data Vault',
    schema: VaultHistoryHealthSchema, consumer: 'public/data-vault/data-vault.js',
    reads: ['window', 'writer', 'retention'],
  },
  {
    endpoint: '/system/fabric/history/stats', module: 'Data Vault',
    schema: VaultStatsSchema, consumer: 'public/data-vault/data-vault.js',
    reads: ['sources'],
  },
  {
    endpoint: '/system/fabric/history', query: '?limit=2', module: 'Data Vault',
    schema: VaultHistoryQuerySchema, consumer: 'public/data-vault/data-vault.js',
    reads: [],
  },
  {
    endpoint: '/system/fabric/history/replay', query: '?limit=2', module: 'Data Vault',
    schema: VaultReplaySchema, consumer: 'public/data-vault/data-vault.js',
    reads: [],
  },
  {
    endpoint: '/system/fabric/history/entity-types', module: 'Data Vault',
    schema: VaultEntityTypesSchema, consumer: 'public/data-vault/data-vault.js',
    reads: ['entityTypes'],
  },
  {
    endpoint: '/system/fabric/sources', module: 'Data Vault / Live Data Flow',
    schema: FabricSourcesSchema, consumer: 'public/data-vault/data-vault.js',
    reads: [],
  },

  // ── Source Core ──
  {
    endpoint: '/system/sources', module: 'Source Core',
    schema: SourceRegistrySchema, consumer: 'public/source-core/source-core.js',
    reads: ['state', 'sources', 'counts', 'generatedAt', 'measuredAt'],
  },
  {
    endpoint: '/system/sources/health', module: 'Source Core',
    schema: SourceHealthSchema, consumer: 'public/source-core/source-core.js',
    reads: ['overall'],
  },
  {
    endpoint: '/system/sources/flow', module: 'Source Core',
    schema: SourceFlowSchema, consumer: 'public/source-core/source-core.js',
    reads: ['origins', 'intake', 'validation', 'counts'],
  },
  {
    endpoint: '/system/sources/fabric:users', module: 'Source Core',
    schema: SourceDetailSchema, consumer: null,
    reads: [],
  },
  {
    endpoint: '/system/sources/fabric:users/consumers', module: 'Source Core',
    schema: SourceConsumersSchema, consumer: 'public/source-core/source-core.js',
    reads: ['impact'],
  },
  {
    endpoint: '/system/sources/fabric:users/lineage', module: 'Source Core',
    schema: SourceLineageSchema, consumer: 'public/source-core/source-core.js',
    reads: ['stages'],
  },

  // ── SYSTEM ──
  {
    endpoint: '/system/overview', module: 'SYSTEM',
    schema: SystemOverviewSchema, consumer: 'public/system/system.js',
    reads: [],
  },

  // ── Cybersecurity Command Center ──
  {
    endpoint: '/system/cybersecurity', module: 'Cybersecurity',
    schema: CommandCenterSchema, consumer: 'public/cybersecurity/cybersecurity.js',
    reads: ['state', 'reason', 'measuredAt', 'instance', 'posture', 'groups', 'domains', 'areas',
      'lifecycle', 'boundaries', 'rls', 'events', 'unassignedRouters'],
  },
  {
    endpoint: '/system/cybersecurity/domains/rls', module: 'Cybersecurity',
    schema: SecDomainDetailSchema, consumer: 'public/cybersecurity/cybersecurity.js',
    reads: ['controlList', 'rowList', 'recentEvents', 'recentSignals'],
  },

  // ── Algorithms ──
  {
    endpoint: '/system/algorithms', module: 'Algorithms',
    schema: AlgorithmsOverviewSchema, consumer: 'public/algorithms/algorithms.js',
    reads: ['state', 'reason', 'measuredAt', 'loop', 'domains', 'algorithms', 'guarantees', 'totals', 'monitoring'],
  },
  {
    endpoint: '/system/algorithms/xg', module: 'Algorithms',
    schema: AlgDetailSchema, consumer: 'public/algorithms/algorithms.js',
    reads: ['summary', 'usedBy', 'inputs', 'outputs', 'dependsOn', 'source', 'fingerprint', 'approval',
      'versions', 'tests', 'notSimulatedBecause', 'scenarios'],
  },
];

// ── the compile-time pin ─────────────────────────────────────────────────────
//
// Where an interface already exists in `src/`, the schema is not a second
// opinion about the same shape — it is the same shape, and `tsc` enforces it.
// Add a field to `InfraComponent` without adding it here and the build fails,
// which is the cheapest possible moment to find out.

import type {
  InfraComponent, InfraDistrict, InfraRelationship, InfraTechnology,
} from '../infra/infrastructure-registry.service';
import type { Signal, Incident, InfraRule } from '../infra/infrastructure-health.service';
import type {
  PlatformSource, SourceControl, LineageStage, ImpactNode,
} from '../sources/source-registry.service';
import type {
  CommandCenterOverview, DomainDetail, DomainSummary, AreaView, StageView, RlsView, EventsOverview, PostureView,
} from '../cyber-defense/control-plane/control-plane.service';
import type { AlgorithmsOverview, AlgorithmSummary, AlgorithmDetail } from '../algorithms/algorithms.service';

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/* eslint-disable @typescript-eslint/no-unused-vars */
const _component: Exact<z.infer<typeof InfraComponentSchema>, InfraComponent> = true;
const _district: Exact<z.infer<typeof InfraDistrictSchema>, InfraDistrict> = true;
const _relationship: Exact<z.infer<typeof InfraRelationshipSchema>, InfraRelationship> = true;
const _technology: Exact<z.infer<typeof InfraTechnologySchema>, InfraTechnology> = true;
const _signal: Exact<z.infer<typeof InfraSignalSchema>, Signal> = true;
const _incident: Exact<z.infer<typeof InfraIncidentSchema>, Incident> = true;
const _rule: Exact<z.infer<typeof InfraRuleSchema>, InfraRule> = true;
const _source: Exact<z.infer<typeof PlatformSourceSchema>, PlatformSource> = true;
const _control: Exact<z.infer<typeof SourceControlSchema>, SourceControl> = true;
const _stage: Exact<z.infer<typeof SourceLineageSchema>['stages'][number], LineageStage> = true;
const _impact: Exact<z.infer<typeof SourceConsumersSchema>['impact'][number], ImpactNode> = true;
const _ccOverview: Exact<z.infer<typeof CommandCenterSchema>, CommandCenterOverview> = true;
const _ccDomain: Exact<z.infer<typeof SecDomainSummarySchema>, DomainSummary> = true;
const _ccDetail: Exact<z.infer<typeof SecDomainDetailSchema>, DomainDetail> = true;
const _ccArea: Exact<z.infer<typeof SecAreaSchema>, AreaView> = true;
const _ccStage: Exact<z.infer<typeof SecStageSchema>, StageView> = true;
const _ccRls: Exact<z.infer<typeof SecRlsSchema>, RlsView> = true;
const _ccEvents: Exact<z.infer<typeof SecEventsOverviewSchema>, EventsOverview> = true;
const _ccPosture: Exact<z.infer<typeof SecPostureSchema>, PostureView> = true;
const _algOverview: Exact<z.infer<typeof AlgorithmsOverviewSchema>, AlgorithmsOverview> = true;
const _algSummary: Exact<z.infer<typeof AlgSummarySchema>, AlgorithmSummary> = true;
const _algDetail: Exact<z.infer<typeof AlgDetailSchema>, AlgorithmDetail> = true;
void [_algOverview, _algSummary, _algDetail];
void [_component, _district, _relationship, _technology, _signal, _incident, _rule,
  _source, _control, _stage, _impact,
  _ccOverview, _ccDomain, _ccDetail, _ccArea, _ccStage, _ccRls, _ccEvents, _ccPosture];
