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
    reads: ['state', 'districts', 'components', 'relationships', 'future', 'layout'],
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

  // ── SYSTEM ──
  {
    endpoint: '/system/overview', module: 'SYSTEM',
    schema: SystemOverviewSchema, consumer: 'public/system/system.js',
    reads: [],
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

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/* eslint-disable @typescript-eslint/no-unused-vars */
const _component: Exact<z.infer<typeof InfraComponentSchema>, InfraComponent> = true;
const _district: Exact<z.infer<typeof InfraDistrictSchema>, InfraDistrict> = true;
const _relationship: Exact<z.infer<typeof InfraRelationshipSchema>, InfraRelationship> = true;
const _technology: Exact<z.infer<typeof InfraTechnologySchema>, InfraTechnology> = true;
const _signal: Exact<z.infer<typeof InfraSignalSchema>, Signal> = true;
const _incident: Exact<z.infer<typeof InfraIncidentSchema>, Incident> = true;
const _rule: Exact<z.infer<typeof InfraRuleSchema>, InfraRule> = true;
void [_component, _district, _relationship, _technology, _signal, _incident, _rule];
