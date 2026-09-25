// Live infrastructure health, and the rules that turn it into incidents
// ─────────────────────────────────────────────────────────────────────────────
// THE HALF THAT MOVES
//
// The registry says what exists. This says how it IS, right now, and it is the
// only half that changes between deploys. Every signal below is read from
// something the platform already measures. There is no number in this file that
// the platform does not actually produce, and where a thing is not measured the
// answer is `NOT_INSTRUMENTED` rather than a comfortable default.
//
// WHAT "NOT INSTRUMENTED" MEANS HERE, AND WHY IT IS EVERYWHERE
//
// A dashboard that shows green for a thing nobody measures is worse than one
// that shows nothing: it converts absence of evidence into evidence of health,
// and the first time that matters is during an incident. So:
//
//   NOT_INSTRUMENTED  nothing in this build measures it
//   NOT_CONFIGURED    it could be measured, but the deployment has not set it up
//   UNVERIFIED        it is real, and this process cannot see it (Render deploys)
//   UNKNOWN           we asked and did not get a usable answer
//
// Four different reasons, four different words, because they lead to four
// different actions.
//
// RULES, NOT INTUITION
//
// Every incident below comes from a named rule with a stated threshold and the
// evidence that fired it. `INFRASTRUCTURE_RULES` is exported so the interface
// can show an operator exactly why something is yellow. There is no scoring, no
// weighting and no model: at this stage a deterministic rule an engineer can
// read beats a cleverer thing nobody can audit.
//
// TRANSITIONS, NOT HEARTBEATS
//
// Health is polled. Incidents are not: an incident opens when a rule STARTS
// firing and resolves when it stops, and the Data Fabric hears about the
// transition only. `publishSystemHealthChanged` already says this in its own
// comment — "publishing a snapshot per poll would make a heartbeat look like
// news" — so this file honours that rather than working around it.

import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { redisStatus, redisConfigured } from './redis';
import { registryHealth } from '../fabric/registry/unknown-events';
import { fabricSources } from '../fabric/registry/source-registry';
import { fabricEvents } from '../fabric/registry/event-registry';
import { fabricHistoryHealth } from '../fabric/history/history-writer.service';
import { historyRecoveryHealth, pendingHistoryDelivery } from '../fabric/history/history-recovery.service';
import { historyWindow } from '../fabric/history/history-query.service';
import { archiveStatus } from '../fabric/history/archive';
import { getObjectStore } from '../fabric/media/object-store';
import { publishSystemHealthChanged } from '../fabric/producers/system.producer';
import { manifestOrNull } from './infrastructure-registry.service';

export type HealthState = 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'NOT_CONFIGURED' | 'NOT_INSTRUMENTED' | 'UNVERIFIED' | 'UNKNOWN';
export type Severity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface Signal {
  /** Matches `healthKey` on a manifest component, so the city can join them. */
  key: string;
  state: HealthState;
  /** One line a person can read. Never a raw exception. */
  summary: string;
  /** The measurements this state was derived from. Only measured values. */
  measurements: Record<string, number | string | boolean | null>;
  /** Where the number came from, so a reader can go and check. */
  evidence: string;
  measuredAt: string;
}

// ── thresholds ───────────────────────────────────────────────────────────────
//
// Named, in one place, and reported to the interface with every rule. A
// threshold buried in an `if` is a threshold nobody can question.

export const THRESHOLDS = {
  dbLatencyWarnMs: Number(process.env.INFRA_DB_LATENCY_WARN_MS ?? 250),
  dbLatencyCriticalMs: Number(process.env.INFRA_DB_LATENCY_CRITICAL_MS ?? 1000),
  historyPendingWarn: Number(process.env.INFRA_HISTORY_PENDING_WARN ?? 50),
  historyPendingCritical: Number(process.env.INFRA_HISTORY_PENDING_CRITICAL ?? 500),
  historyFailuresWarn: Number(process.env.INFRA_HISTORY_FAILURES_WARN ?? 1),
  historyDroppedCritical: Number(process.env.INFRA_HISTORY_DROPPED_CRITICAL ?? 1),
  heapUsedWarnRatio: Number(process.env.INFRA_HEAP_WARN_RATIO ?? 0.85),
  heapUsedCriticalRatio: Number(process.env.INFRA_HEAP_CRITICAL_RATIO ?? 0.95),
  registryUnknownWarn: Number(process.env.INFRA_REGISTRY_UNKNOWN_WARN ?? 1),
  registrySchemaFailWarn: Number(process.env.INFRA_REGISTRY_SCHEMA_FAIL_WARN ?? 1),
} as const;

const iso = () => new Date().toISOString();
const round = (n: number) => Math.round(n * 100) / 100;

// ── individual signals ───────────────────────────────────────────────────────

/**
 * Is the database reachable, and how long did it take to say so?
 *
 * A real round trip — `SELECT 1` — because "the pool object exists" is not
 * connectivity. The latency is the measurement the Database district reports,
 * and it is the only database latency figure in this file: nothing is averaged
 * over a window the platform does not keep.
 */
async function databaseSignal(): Promise<Signal> {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const latencyMs = Date.now() - started;
    const state: HealthState = latencyMs >= THRESHOLDS.dbLatencyCriticalMs ? 'CRITICAL'
      : latencyMs >= THRESHOLDS.dbLatencyWarnMs ? 'WARNING' : 'HEALTHY';
    return {
      key: 'database', state,
      summary: state === 'HEALTHY'
        ? `Reachable in ${latencyMs} ms.`
        : `Round trip took ${latencyMs} ms.`,
      measurements: { latencyMs, warnMs: THRESHOLDS.dbLatencyWarnMs, criticalMs: THRESHOLDS.dbLatencyCriticalMs },
      evidence: 'SELECT 1 round trip through Prisma',
      measuredAt: iso(),
    };
  } catch (err) {
    return {
      key: 'database', state: 'CRITICAL',
      summary: 'The database did not answer a connectivity probe.',
      measurements: { latencyMs: Date.now() - started },
      evidence: `SELECT 1 failed: ${String((err as Error)?.message ?? '').slice(0, 120)}`,
      measuredAt: iso(),
    };
  }
}

/** The process this code is running in. Real `process` values, nothing derived. */
function processSignal(): Signal {
  const mem = process.memoryUsage();
  const ratio = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;
  const state: HealthState = ratio >= THRESHOLDS.heapUsedCriticalRatio ? 'CRITICAL'
    : ratio >= THRESHOLDS.heapUsedWarnRatio ? 'WARNING' : 'HEALTHY';
  return {
    key: 'process', state,
    summary: `Up ${Math.floor(process.uptime())} s, heap ${Math.round(ratio * 100)}% of allocation.`,
    measurements: {
      uptimeSeconds: Math.floor(process.uptime()),
      heapUsedMb: round(mem.heapUsed / 1048576),
      heapTotalMb: round(mem.heapTotal / 1048576),
      rssMb: round(mem.rss / 1048576),
      heapRatio: round(ratio),
      nodeVersion: process.version,
    },
    evidence: 'process.memoryUsage(), process.uptime()',
    measuredAt: iso(),
  };
}

/** The Data Fabric registry's own counters. */
function fabricSignal(): Signal {
  const h = registryHealth() as unknown as Record<string, number>;
  const unknown = Number(h.unknownEventCount ?? 0);
  const schemaFail = Number(h.schemaFailureCount ?? 0);
  const state: HealthState = schemaFail >= THRESHOLDS.registrySchemaFailWarn ? 'WARNING'
    : unknown >= THRESHOLDS.registryUnknownWarn ? 'WARNING' : 'HEALTHY';
  return {
    key: 'fabric', state,
    summary: state === 'HEALTHY'
      ? 'No unknown event types and no schema failures since start.'
      : `${unknown} unknown event type(s), ${schemaFail} schema failure(s) since start.`,
    measurements: {
      unknownEventCount: unknown,
      schemaFailureCount: schemaFail,
      registeredSources: fabricSources().length,
      registeredEventTypes: fabricEvents().length,
      producedEventTypes: fabricEvents().filter((e) => e.produced).length,
    },
    evidence: 'src/fabric/registry/unknown-events.ts registryHealth()',
    measuredAt: iso(),
  };
}

/** The historical store: writer counters plus the durable pending count. */
async function historicalStoreSignal(): Promise<Signal> {
  const w = fabricHistoryHealth() as unknown as Record<string, unknown>;
  const recovery = historyRecoveryHealth();
  let pending: number | null = null;
  let windowTotal: number | null = null;
  let earliest: string | null = null;

  try {
    const [p, win] = await Promise.all([pendingHistoryDelivery(), historyWindow()]);
    pending = p.pending;
    windowTotal = win.total;
    earliest = win.earliest;
  } catch (err) {
    return {
      key: 'historicalStore', state: 'UNKNOWN',
      summary: 'The historical store could not be read.',
      measurements: { failures: Number(w.failures ?? 0) },
      evidence: `history read failed: ${String((err as Error)?.message ?? '').slice(0, 120)}`,
      measuredAt: iso(),
    };
  }

  const failures = Number(w.failures ?? 0);
  const dropped = Number(w.dropped ?? 0);
  const state: HealthState =
    dropped >= THRESHOLDS.historyDroppedCritical ? 'CRITICAL'
      : (pending ?? 0) >= THRESHOLDS.historyPendingCritical ? 'CRITICAL'
        : (pending ?? 0) >= THRESHOLDS.historyPendingWarn ? 'WARNING'
          : failures >= THRESHOLDS.historyFailuresWarn ? 'WARNING'
            : 'HEALTHY';

  return {
    key: 'historicalStore', state,
    summary: state === 'HEALTHY'
      ? `${windowTotal ?? 0} events stored, nothing pending.`
      : `${pending ?? 0} pending deliver${(pending ?? 0) === 1 ? 'y' : 'ies'}, ${failures} write failure(s).`,
    measurements: {
      storedEvents: windowTotal,
      earliestEvent: earliest,
      pendingDeliveries: pending,
      writeFailures: failures,
      dropped,
      duplicates: Number(w.duplicates ?? 0),
      retryBacklog: Number(w.retryBacklog ?? 0),
      recoveryEnabled: !!recovery.enabled,
      recoveredTotal: recovery.totalRecovered,
      pendingWarnAt: THRESHOLDS.historyPendingWarn,
      pendingCriticalAt: THRESHOLDS.historyPendingCritical,
    },
    evidence: 'fabricHistoryHealth(), pendingHistoryDelivery(), historyWindow()',
    measuredAt: iso(),
  };
}

/** Redis, but only when the deployment configured it. */
function redisSignal(): Signal {
  if (!redisConfigured()) {
    return {
      key: 'redis', state: 'NOT_CONFIGURED',
      summary: 'No Redis URL is configured for this deployment.',
      measurements: { configured: false },
      evidence: 'src/infra/redis.ts redisConfigured()',
      measuredAt: iso(),
    };
  }
  const s = redisStatus();
  return {
    key: 'redis', state: s.healthy ? 'HEALTHY' : 'CRITICAL',
    summary: s.healthy ? 'Connected.' : 'Configured but not connected.',
    measurements: {
      configured: true, healthy: s.healthy, everConnected: s.everConnected,
      outages: s.outages, lastOutageAt: s.lastOutageAt,
    },
    evidence: 'src/infra/redis.ts redisStatus()',
    measuredAt: iso(),
  };
}

/** Object storage: which provider the port resolved to, and whether it is durable. */
function objectStoreSignal(): Signal {
  let provider = 'UNKNOWN';
  try { provider = String(getObjectStore().provider ?? 'UNKNOWN'); } catch (_) { /* reported below */ }
  const durable = provider !== 'MEMORY' && provider !== 'UNKNOWN';
  return {
    key: 'objectStore',
    state: durable ? 'HEALTHY' : 'NOT_CONFIGURED',
    summary: durable
      ? `Resolved to ${provider}.`
      : 'The object-storage port resolved to an in-memory store, which does not survive a restart.',
    measurements: { provider, durable },
    evidence: 'src/fabric/media/object-store.ts getObjectStore().provider',
    measuredAt: iso(),
  };
}

/** The cold archive. Not configured in this build, and it says so. */
function archiveSignal(): Signal {
  const a = archiveStatus();
  return {
    key: 'archive',
    state: a.enabled ? 'HEALTHY' : 'NOT_CONFIGURED',
    summary: a.enabled
      ? 'Configured.'
      : `Not configured. Missing: ${a.missing.join(', ')}.`,
    measurements: {
      enabled: a.enabled, state: a.state,
      provider: a.objectStore.provider, batchesExported: 0,
    },
    evidence: 'src/fabric/history/archive.ts archiveStatus()',
    measuredAt: iso(),
  };
}

/**
 * The deployment. Honest about what this process cannot see.
 *
 * Render deploys are not observable from inside the running service: there are
 * no Render API credentials here and the CI deploy job is a no-op without a
 * hook URL. Reporting HEALTHY because the process is running would be the
 * single most misleading thing this dashboard could do — the process running is
 * evidence that A deploy succeeded, not that THE latest commit is live.
 */
function deploymentSignal(): Signal {
  const m = manifestOrNull();
  return {
    key: 'deployment', state: 'UNVERIFIED',
    summary: 'This process cannot observe the deployment platform. CI green is not production live.',
    measurements: {
      manifestGeneratedAt: m ? m.generatedAt : null,
      platformVersion: m ? m.platform.version : null,
      autoDeploy: m ? (m.deployment.services.find((s) => s.type === 'web')?.autoDeploy ?? null) : null,
    },
    evidence: 'src/infra/generated/infrastructure-manifest.json — deployment.observable is false',
    measuredAt: iso(),
  };
}

/** CI results are produced outside this process and are not readable from it. */
function ciSignal(): Signal {
  return {
    key: 'ci', state: 'NOT_INSTRUMENTED',
    summary: 'CI results live in GitHub Actions and are not readable from the running server.',
    measurements: {},
    evidence: '.github/workflows/ci.yml — no result channel into the process',
    measuredAt: iso(),
  };
}

/** Tests do not run in production, so there is nothing live to report. */
function testsSignal(): Signal {
  const m = manifestOrNull();
  return {
    key: 'tests', state: 'NOT_INSTRUMENTED',
    summary: 'Test results are a CI artefact, not a runtime signal.',
    measurements: { suites: m ? (m.surface.testSuites ?? 0) : 0 },
    evidence: 'tests/ — counted at build, not executed at runtime',
    measuredAt: iso(),
  };
}

/** The AI provider: configured or not. Availability is not probed. */
function aiSignal(): Signal {
  const configured = Boolean(process.env.ANTHROPIC_API_KEY);
  return {
    key: 'aiProvider',
    state: configured ? 'HEALTHY' : 'NOT_CONFIGURED',
    summary: configured
      ? 'An AI provider key is configured.'
      : 'No AI provider key is configured for this deployment.',
    // Deliberately no reachability probe: calling a paid provider every ten
    // seconds to colour a square would cost money to learn something no user
    // asked about.
    measurements: { configured, probed: false },
    evidence: 'presence of ANTHROPIC_API_KEY (name only; the value is never read)',
    measuredAt: iso(),
  };
}

function integrationSignal(key: string, envName: string, label: string): Signal {
  const configured = Boolean(process.env[envName]);
  return {
    key,
    state: configured ? 'HEALTHY' : 'NOT_CONFIGURED',
    summary: configured ? `${label} is configured.` : `${label} is not configured for this deployment.`,
    measurements: { configured, probed: false },
    evidence: `presence of ${envName} (name only; the value is never read)`,
    measuredAt: iso(),
  };
}

/** Every signal, measured together. */
/**
 * Familista Vision, as a signal Infrastructure City can draw.
 *
 * Vision does not get a second monitoring surface. It gets a reading in the one
 * the platform already has, joined by `healthKey` like every other component,
 * so an operator watching the city sees a Vision problem beside a database
 * problem rather than having to know Vision exists and go and look.
 *
 * Deliberately CHEAP: it reads the engine's identity and counts what is
 * addressable. It does not normalise a session, because the city polls, and
 * parsing four thousand observations on a health tick would make the monitoring
 * more expensive than the thing it monitors.
 */
async function visionSignal(): Promise<Signal> {
  const { visionEngine, isUnavailable, configuredTarget } =
    await import('../vision-platform/engine-contract');
  const { visionEventCatalogue } = await import('../vision-platform/vision-events');
  try {
    const engine = visionEngine();
    const identity = await engine.identify();
    const refs = await engine.listSessions();
    const sessions = isUnavailable(refs) ? null : refs.length;
    const eventTypes = visionEventCatalogue().length;
    const target = configuredTarget();

    // A Vision Hub target on a deployment with no Hub is NOT_CONFIGURED rather
    // than a fault: somebody selected hardware that does not exist yet, and the
    // remedy is a setting, not an incident.
    if (identity.status === 'NOT_IMPLEMENTED') {
      return {
        key: 'vision',
        state: 'NOT_CONFIGURED',
        summary: `Vision is targeting ${target}, which is not implemented.`,
        measurements: { processingTarget: target, sessions: null, eventTypes },
        evidence: 'vision-platform engine contract: identify()',
        measuredAt: iso(),
      };
    }
    if (sessions === null) {
      return {
        key: 'vision',
        // WARNING, not CRITICAL: an engine with no session store is a
        // deployment that has not been given evidence to read, which is an
        // operator's configuration, not an outage.
        state: 'WARNING',
        summary: 'The Vision engine answered but exposes no session store.',
        measurements: { processingTarget: target, sessions: null, eventTypes },
        evidence: 'vision-platform engine contract: listSessions()',
        measuredAt: iso(),
      };
    }
    return {
      key: 'vision',
      state: 'HEALTHY',
      summary: `Vision is ${identity.status} on ${target} with ${sessions} session`
        + `${sessions === 1 ? '' : 's'} addressable.`,
      measurements: {
        processingTarget: target,
        deviceKind: identity.deviceKind,
        sessions,
        eventTypes,
      },
      evidence: 'vision-platform engine contract: identify() and listSessions()',
      measuredAt: iso(),
    };
  } catch (err) {
    return {
      key: 'vision',
      state: 'WARNING',
      summary: 'The Vision engine could not be reached.',
      measurements: { error: (err as Error).message.slice(0, 160) },
      evidence: 'vision-platform engine contract',
      measuredAt: iso(),
    };
  }
}

export async function infrastructureSignals(): Promise<Signal[]> {
  const [db, history, vision] = await Promise.all([
    databaseSignal(), historicalStoreSignal(), visionSignal(),
  ]);
  return [
    processSignal(), db, fabricSignal(), history, redisSignal(),
    objectStoreSignal(), archiveSignal(), aiSignal(),
    integrationSignal('stripe', 'STRIPE_SECRET_KEY', 'Stripe'),
    integrationSignal('email', 'SENDGRID_API_KEY', 'Email delivery'),
    deploymentSignal(), ciSignal(), testsSignal(), vision,
  ];
}

// ── rules ────────────────────────────────────────────────────────────────────

export interface InfraRule {
  id: string;
  title: string;
  severity: Severity;
  /** The component this rule speaks about, so an alert can locate itself. */
  componentId: string;
  districtId: string;
  /** Stated so the interface can show it. A threshold nobody can see is folklore. */
  condition: string;
  /** What to look at next. Never an action this service performs itself. */
  nextStep: string;
  impact: string;
}

export const INFRASTRUCTURE_RULES: InfraRule[] = [
  {
    id: 'db-unreachable', title: 'Database unreachable', severity: 'CRITICAL',
    componentId: 'postgres', districtId: 'database',
    condition: 'A SELECT 1 probe through Prisma failed.',
    nextStep: 'Check the database service and the connection pool. Every persisted read and write depends on this.',
    impact: 'The platform cannot read or write any persisted data.',
  },
  {
    id: 'db-latency', title: 'Database latency elevated', severity: 'WARNING',
    componentId: 'postgres', districtId: 'database',
    condition: `SELECT 1 round trip at or above ${THRESHOLDS.dbLatencyWarnMs} ms (critical at ${THRESHOLDS.dbLatencyCriticalMs} ms).`,
    nextStep: 'Look at database load and long-running queries before request latency follows.',
    impact: 'Every database-backed request pays this latency.',
  },
  {
    id: 'history-backlog', title: 'Historical delivery backlog', severity: 'WARNING',
    componentId: 'historical-store', districtId: 'vault',
    condition: `Outbox rows with no historical row at or above ${THRESHOLDS.historyPendingWarn} (critical at ${THRESHOLDS.historyPendingCritical}).`,
    nextStep: 'Open Data Vault → Storage. The recovery worker sweeps every five minutes; a backlog that does not fall means writes are failing.',
    impact: 'Events are committed and durable, but not yet queryable as history.',
  },
  {
    id: 'history-dropped', title: 'Historical records dropped', severity: 'CRITICAL',
    componentId: 'historical-store', districtId: 'vault',
    condition: `The writer reports ${THRESHOLDS.historyDroppedCritical} or more exhausted records.`,
    nextStep: 'Inspect the historical writer. A dropped record is one the in-process queue gave up on; recovery may still deliver it from the outbox.',
    impact: 'History may be incomplete for the affected window.',
  },
  {
    id: 'history-failures', title: 'Historical write failures', severity: 'WARNING',
    componentId: 'historical-store', districtId: 'vault',
    condition: `The writer reports ${THRESHOLDS.historyFailuresWarn} or more failed writes since start.`,
    nextStep: 'Check database health first — the writer fails when the store does.',
    impact: 'Affected events fall back to the durable outbox and are recovered later.',
  },
  {
    id: 'fabric-unknown', title: 'Unknown event types seen', severity: 'WARNING',
    componentId: 'data-fabric', districtId: 'fabric',
    condition: `The registry has seen ${THRESHOLDS.registryUnknownWarn} or more unregistered event types.`,
    nextStep: 'A producer is publishing a type the registry does not declare. Check recent producer changes.',
    impact: 'Unregistered events carry no schema and are classified defensively.',
  },
  {
    id: 'fabric-schema', title: 'Event schema failures', severity: 'WARNING',
    componentId: 'data-fabric', districtId: 'fabric',
    condition: `The registry has rejected ${THRESHOLDS.registrySchemaFailWarn} or more payloads.`,
    nextStep: 'A producer is sending a payload its own contract rejects. Check the failing event type.',
    impact: 'Rejected events are not published.',
  },
  {
    id: 'redis-down', title: 'Redis configured but unreachable', severity: 'CRITICAL',
    componentId: 'redis', districtId: 'cache',
    condition: 'A Redis URL is configured and the client is not connected.',
    nextStep: 'Rate limiting falls back to a per-process memory store while Redis is down, which weakens limits across instances.',
    impact: 'Distributed rate limiting and any Redis-backed coordination are degraded.',
  },
  {
    id: 'heap-pressure', title: 'Process heap pressure', severity: 'WARNING',
    componentId: 'platform-core', districtId: 'core',
    condition: `Heap used at or above ${Math.round(THRESHOLDS.heapUsedWarnRatio * 100)}% of allocation (critical at ${Math.round(THRESHOLDS.heapUsedCriticalRatio * 100)}%).`,
    nextStep: 'Watch for a rising trend rather than a single reading; a garbage collection cycle moves this number.',
    impact: 'Sustained pressure precedes slowdowns and, eventually, a restart.',
  },
  {
    id: 'object-store-volatile', title: 'Object storage is in-memory', severity: 'INFO',
    componentId: 'object-store', districtId: 'storage',
    condition: 'The object-storage port resolved to a memory store rather than a configured provider.',
    nextStep: 'Configure object storage before relying on media durability. Nothing written survives a restart.',
    impact: 'Stored objects are lost when the process restarts.',
  },
];

export function ruleById(id: string): InfraRule | null {
  return INFRASTRUCTURE_RULES.find((r) => r.id === id) ?? null;
}

// ── incidents ────────────────────────────────────────────────────────────────

export type IncidentStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface Incident {
  id: string;
  ruleId: string;
  title: string;
  severity: Severity;
  componentId: string;
  districtId: string;
  status: IncidentStatus;
  detectedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  /** How many times the rule re-fired while this incident was open. */
  occurrences: number;
  /** The measurement that fired the rule, at the moment it fired. */
  evidence: Record<string, unknown>;
  summary: string;
  impact: string;
  nextStep: string;
}

/**
 * Open incidents, by rule.
 *
 * PROCESS-SCOPED, and that is a real limitation rather than an oversight.
 * Durable acknowledgement would need a table, and the brief is explicit that a
 * migration should not be created for visualisation without saying why first.
 * So: incidents derive from live evidence on every evaluation, their
 * TRANSITIONS are published to the Data Fabric and therefore persist in the
 * Historical Event Store, and acknowledgement lives only in this process and is
 * labelled `scope: 'PROCESS'` wherever it is reported.
 */
const open = new Map<string, Incident>();
/** Resolved incidents, newest first, bounded. The city's own short memory. */
const resolved: Incident[] = [];
const RESOLVED_LIMIT = 100;

/** The last state published per signal, so only TRANSITIONS reach the Fabric. */
const lastPublished = new Map<string, HealthState>();

let sequence = 0;
const nextId = () => `inc_${Date.now().toString(36)}_${(sequence += 1).toString(36)}`;

function fire(rule: InfraRule, summary: string, evidence: Record<string, unknown>): void {
  const existing = open.get(rule.id);
  if (existing) {
    // Deduplicated: the same rule still firing is the same incident, not news.
    existing.occurrences += 1;
    existing.updatedAt = iso();
    existing.evidence = evidence;
    existing.summary = summary;
    return;
  }
  open.set(rule.id, {
    id: nextId(),
    ruleId: rule.id,
    title: rule.title,
    severity: rule.severity,
    componentId: rule.componentId,
    districtId: rule.districtId,
    status: 'OPEN',
    detectedAt: iso(),
    updatedAt: iso(),
    resolvedAt: null,
    acknowledgedAt: null,
    occurrences: 1,
    evidence,
    summary,
    impact: rule.impact,
    nextStep: rule.nextStep,
  });
}

function clear(ruleId: string): void {
  const inc = open.get(ruleId);
  if (!inc) return;
  open.delete(ruleId);
  inc.status = 'RESOLVED';
  inc.resolvedAt = iso();
  inc.updatedAt = inc.resolvedAt;
  // History is kept. A recovered incident is still something that happened,
  // and deleting it because the graph went green is how a platform forgets its
  // own bad nights.
  resolved.unshift(inc);
  if (resolved.length > RESOLVED_LIMIT) resolved.length = RESOLVED_LIMIT;
}

/**
 * Run every rule against a fresh set of signals.
 *
 * Deterministic and side-effect-light: it opens, updates and resolves
 * incidents, and publishes a Fabric event ONLY where a signal's state actually
 * changed since the last evaluation.
 */
export function evaluate(signals: Signal[]): Incident[] {
  const by = new Map(signals.map((s) => [s.key, s]));
  const m = (key: string) => by.get(key)?.measurements ?? {};
  const state = (key: string) => by.get(key)?.state;

  const db = m('database');
  if (state('database') === 'CRITICAL' && db.latencyMs !== undefined && !('warnMs' in db)) {
    fire(ruleById('db-unreachable')!, 'A connectivity probe to the database failed.', db);
  } else { clear('db-unreachable'); }

  if (state('database') === 'WARNING' || (state('database') === 'CRITICAL' && 'warnMs' in db)) {
    fire(ruleById('db-latency')!, `Round trip measured ${db.latencyMs} ms.`, db);
  } else { clear('db-latency'); }

  const hist = m('historicalStore');
  const pending = Number(hist.pendingDeliveries ?? 0);
  if (pending >= THRESHOLDS.historyPendingWarn) {
    fire(ruleById('history-backlog')!, `${pending} event(s) committed to the outbox have no historical row.`, hist);
  } else { clear('history-backlog'); }

  if (Number(hist.dropped ?? 0) >= THRESHOLDS.historyDroppedCritical) {
    fire(ruleById('history-dropped')!, `${hist.dropped} record(s) exhausted their retries.`, hist);
  } else { clear('history-dropped'); }

  if (Number(hist.writeFailures ?? 0) >= THRESHOLDS.historyFailuresWarn) {
    fire(ruleById('history-failures')!, `${hist.writeFailures} historical write(s) failed since start.`, hist);
  } else { clear('history-failures'); }

  const fab = m('fabric');
  if (Number(fab.unknownEventCount ?? 0) >= THRESHOLDS.registryUnknownWarn) {
    fire(ruleById('fabric-unknown')!, `${fab.unknownEventCount} unregistered event type(s) seen.`, fab);
  } else { clear('fabric-unknown'); }

  if (Number(fab.schemaFailureCount ?? 0) >= THRESHOLDS.registrySchemaFailWarn) {
    fire(ruleById('fabric-schema')!, `${fab.schemaFailureCount} payload(s) rejected by their own schema.`, fab);
  } else { clear('fabric-schema'); }

  if (state('redis') === 'CRITICAL') {
    fire(ruleById('redis-down')!, 'Redis is configured but the client is not connected.', m('redis'));
  } else { clear('redis-down'); }

  const proc = m('process');
  if (state('process') === 'WARNING' || state('process') === 'CRITICAL') {
    fire(ruleById('heap-pressure')!, `Heap at ${Math.round(Number(proc.heapRatio ?? 0) * 100)}% of allocation.`, proc);
  } else { clear('heap-pressure'); }

  if (state('objectStore') === 'NOT_CONFIGURED') {
    fire(ruleById('object-store-volatile')!, 'The object-storage port resolved to a memory store.', m('objectStore'));
  } else { clear('object-store-volatile'); }

  publishTransitions(signals);
  return [...open.values()].sort(bySeverity);
}

function bySeverity(a: Incident, b: Incident): number {
  const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
  return rank[a.severity] - rank[b.severity] || a.detectedAt.localeCompare(b.detectedAt);
}

/**
 * Tell the Data Fabric about a state CHANGE, and only a change.
 *
 * `publishSystemHealthChanged` is an existing, registered contract whose own
 * comment insists on exactly this discipline. Publishing every poll would put a
 * heartbeat into the historical store for ever — thousands of identical rows
 * whose only content is "still fine" — and the store is the one place that must
 * not be filled with noise.
 *
 * Never throws: an infrastructure view must not be able to break the publisher
 * it is observing.
 */
function publishTransitions(signals: Signal[]): void {
  for (const s of signals) {
    // Signals that cannot change are not transitions worth recording.
    if (s.state === 'NOT_INSTRUMENTED' || s.state === 'UNVERIFIED') continue;
    const previous = lastPublished.get(s.key);
    if (previous === s.state) continue;
    lastPublished.set(s.key, s.state);
    if (previous === undefined) continue;   // first observation is not a transition
    try {
      publishSystemHealthChanged(
        `infrastructure:${s.key}`, previous, s.state,
        typeof s.measurements.latencyMs === 'number' ? s.measurements.latencyMs : null,
      );
    } catch (err) {
      logger.warn('[infrastructure] health transition publish failed', {
        key: s.key, err: String((err as Error)?.message ?? '').slice(0, 120),
      });
    }
  }
}

export function openIncidents(): Incident[] { return [...open.values()].sort(bySeverity); }
export function resolvedIncidents(): Incident[] { return [...resolved]; }

/**
 * Acknowledge an open incident.
 *
 * Process-scoped, and the API says so in its response. Making this durable is a
 * schema change, and this build does not make one.
 */
export function acknowledgeIncident(incidentId: string): Incident | null {
  for (const inc of open.values()) {
    if (inc.id !== incidentId) continue;
    inc.status = 'ACKNOWLEDGED';
    inc.acknowledgedAt = iso();
    inc.updatedAt = inc.acknowledgedAt;
    return inc;
  }
  return null;
}

/** Clear all incident state. Tests, and a controlled reset. */
export function resetInfrastructureIncidents(): void {
  open.clear();
  resolved.length = 0;
  lastPublished.clear();
  sequence = 0;
}

// ── the composed view ────────────────────────────────────────────────────────

export type OverallState = 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';

export interface InfrastructureHealth {
  overall: OverallState;
  signals: Signal[];
  incidents: Incident[];
  resolved: Incident[];
  /** Counts by severity, for the alert panel's own header. */
  counts: { critical: number; warning: number; info: number; healthy: number; notInstrumented: number };
  thresholds: typeof THRESHOLDS;
  /** Acknowledgement is process-scoped; saying so is part of the contract. */
  scope: 'PROCESS';
  measuredAt: string;
}

export async function infrastructureHealth(): Promise<InfrastructureHealth> {
  const signals = await infrastructureSignals();
  const incidents = evaluate(signals);

  const critical = incidents.filter((i) => i.severity === 'CRITICAL').length;
  const warning = incidents.filter((i) => i.severity === 'WARNING').length;
  const info = incidents.filter((i) => i.severity === 'INFO').length;

  return {
    overall: critical > 0 ? 'CRITICAL' : warning > 0 ? 'WARNING'
      : signals.some((s) => s.state === 'UNKNOWN') ? 'UNKNOWN' : 'HEALTHY',
    signals,
    incidents,
    resolved: resolvedIncidents(),
    counts: {
      critical, warning, info,
      healthy: signals.filter((s) => s.state === 'HEALTHY').length,
      notInstrumented: signals.filter((s) => s.state === 'NOT_INSTRUMENTED' || s.state === 'NOT_CONFIGURED' || s.state === 'UNVERIFIED').length,
    },
    thresholds: THRESHOLDS,
    scope: 'PROCESS',
    measuredAt: iso(),
  };
}
