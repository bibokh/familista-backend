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

import fs from 'fs';
import path from 'path';
import v8 from 'v8';
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
import { apiTraffic, API_WINDOW_MINUTES } from './api-traffic';
import { outcomeReading, OUTCOME_WINDOW_MINUTES } from './outcome-meter';
import { webSocketServers, WS_CHANNEL } from './ws-registry';
import { rateLimitStats } from '../middleware/rate-limit.middleware';
import { LOCALES, DEFAULT_LOCALE } from '../i18n/locales';

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
  apiServerErrorsWarn: Number(process.env.INFRA_API_SERVER_ERRORS_WARN ?? 5),
  apiErrorRatioWarn: Number(process.env.INFRA_API_ERROR_RATIO_WARN ?? 0.05),
  apiErrorRatioCritical: Number(process.env.INFRA_API_ERROR_RATIO_CRITICAL ?? 0.25),
  counterWindowMinutes: Number(process.env.INFRA_COUNTER_WINDOW_MINUTES ?? 15),
  outcomeFailuresWarn: Number(process.env.INFRA_OUTCOME_FAILURES_WARN ?? 3),
  outcomeFailureRatioWarn: Number(process.env.INFRA_OUTCOME_FAILURE_RATIO_WARN ?? 0.2),
  outcomeFailureRatioCritical: Number(process.env.INFRA_OUTCOME_FAILURE_RATIO_CRITICAL ?? 0.5),
  outcomeRecoveryStreak: Number(process.env.INFRA_OUTCOME_RECOVERY_STREAK ?? 5),
} as const;

const iso = () => new Date().toISOString();
const round = (n: number) => Math.round(n * 100) / 100;

// ── counters that only ever rise ─────────────────────────────────────────────
//
// Several of the platform's own health counters are since-start totals: the
// historical writer's failures and drops, the registry's unknown types and
// schema rejections. Judging the present by a since-start total means one bad
// minute at boot keeps a district yellow until the next restart, long after the
// thing recovered — and an incident that cannot resolve is not an incident, it
// is wallpaper. So a counter fires a rule while it is RISING: when it went up
// within the last `counterWindowMinutes` of observation. The total is still
// reported, unchanged, beside it.

const counterRises = new Map<string, { value: number; risenAt: number }>();

function risenRecently(key: string, value: number, now: number = Date.now()): boolean {
  const seen = counterRises.get(key);
  if (!seen || value !== seen.value) {
    // A first sighting of a non-zero total counts as a rise now: it happened
    // before anybody was looking, and the operator should see it once.
    const rose = !seen ? value > 0 : value > seen.value;
    counterRises.set(key, { value, risenAt: rose ? now : (seen ? seen.risenAt : 0) });
  }
  const at = counterRises.get(key)!.risenAt;
  return at > 0 && now - at < THRESHOLDS.counterWindowMinutes * 60_000;
}

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

/**
 * The process this code is running in. Real `process` and V8 values.
 *
 * Heap pressure is measured against V8's heap LIMIT — the size at which the
 * process actually runs out of memory — and not against `heapTotal`. The two
 * are easy to confuse and mean opposite things: `heapTotal` is only what V8 has
 * committed so far, it grows on demand and is trimmed after every collection,
 * so `heapUsed / heapTotal` sits between 85% and 99% in a perfectly healthy
 * server. Reading that ratio as pressure painted Node.js and the Platform Core
 * red on a process with gigabytes of headroom.
 */
function processSignal(): Signal {
  const mem = process.memoryUsage();
  const limit = v8.getHeapStatistics().heap_size_limit;
  const ratio = limit > 0 ? mem.heapUsed / limit : 0;
  const state: HealthState = ratio >= THRESHOLDS.heapUsedCriticalRatio ? 'CRITICAL'
    : ratio >= THRESHOLDS.heapUsedWarnRatio ? 'WARNING' : 'HEALTHY';
  return {
    key: 'process', state,
    summary: `Up ${Math.floor(process.uptime())} s, heap ${Math.round(ratio * 100)}% of its `
      + `${Math.round(limit / 1048576)} MB limit.`,
    measurements: {
      uptimeSeconds: Math.floor(process.uptime()),
      heapUsedMb: round(mem.heapUsed / 1048576),
      heapTotalMb: round(mem.heapTotal / 1048576),
      heapLimitMb: round(limit / 1048576),
      rssMb: round(mem.rss / 1048576),
      heapRatio: round(ratio),
      nodeVersion: process.version,
    },
    evidence: 'process.memoryUsage(), v8.getHeapStatistics().heap_size_limit, process.uptime()',
    measuredAt: iso(),
  };
}

/** The Data Fabric registry's own counters. */
function fabricSignal(): Signal {
  const h = registryHealth() as unknown as Record<string, number>;
  const unknown = Number(h.unknownEventCount ?? 0);
  const schemaFail = Number(h.schemaFailureCount ?? 0);
  const unknownActive = unknown >= THRESHOLDS.registryUnknownWarn && risenRecently('fabric.unknown', unknown);
  const schemaActive = schemaFail >= THRESHOLDS.registrySchemaFailWarn && risenRecently('fabric.schema', schemaFail);
  const state: HealthState = schemaActive || unknownActive ? 'WARNING' : 'HEALTHY';
  return {
    key: 'fabric', state,
    summary: state !== 'HEALTHY'
      ? `${unknown} unknown event type(s), ${schemaFail} schema failure(s) since start, rising in the last ${THRESHOLDS.counterWindowMinutes} min.`
      : unknown + schemaFail === 0
        ? 'No unknown event types and no schema failures since start.'
        : `None in the last ${THRESHOLDS.counterWindowMinutes} min (${unknown} unknown type(s), ${schemaFail} schema failure(s) since start).`,
    measurements: {
      unknownEventCount: unknown,
      schemaFailureCount: schemaFail,
      unknownEventsActive: unknownActive,
      schemaFailuresActive: schemaActive,
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
  const retryBacklog = Number(w.retryBacklog ?? 0);
  // Failing now: failures are still rising, or records are still waiting on a
  // retry. A failure the writer has since recovered from is history, not state.
  const failuresActive = failures >= THRESHOLDS.historyFailuresWarn
    && (risenRecently('history.failures', failures) || retryBacklog > 0);
  const droppedActive = dropped >= THRESHOLDS.historyDroppedCritical && risenRecently('history.dropped', dropped);
  const state: HealthState =
    droppedActive ? 'CRITICAL'
      : (pending ?? 0) >= THRESHOLDS.historyPendingCritical ? 'CRITICAL'
        : (pending ?? 0) >= THRESHOLDS.historyPendingWarn ? 'WARNING'
          : failuresActive ? 'WARNING'
            : 'HEALTHY';

  return {
    key: 'historicalStore', state,
    summary: state === 'HEALTHY'
      ? `${windowTotal ?? 0} events stored, nothing pending.`
        + (failures > 0 ? ` ${failures} earlier write failure(s), recovered.` : '')
      : `${pending ?? 0} pending deliver${(pending ?? 0) === 1 ? 'y' : 'ies'}, ${failures} write failure(s).`,
    measurements: {
      storedEvents: windowTotal,
      earliestEvent: earliest,
      pendingDeliveries: pending,
      writeFailures: failures,
      writeFailuresActive: failuresActive,
      dropped,
      droppedActive,
      duplicates: Number(w.duplicates ?? 0),
      retryBacklog,
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

/**
 * The API router: is it answering, and is it answering with server errors?
 *
 * Read from `api-traffic.ts`, which counts every response the API mount
 * completes. The reading itself travels through that router, so a router that
 * is not answering produces no reading at all rather than a green one. A
 * handful of 5xx responses on a quiet platform is not an outage, so a state
 * needs both an absolute count and a share of traffic before it is raised.
 */
function apiSignal(): Signal {
  const t = apiTraffic();
  const ratio = t.responses > 0 ? t.serverErrors / t.responses : 0;
  const enough = t.serverErrors >= THRESHOLDS.apiServerErrorsWarn;
  const state: HealthState = enough && ratio >= THRESHOLDS.apiErrorRatioCritical ? 'CRITICAL'
    : enough && ratio >= THRESHOLDS.apiErrorRatioWarn ? 'WARNING' : 'HEALTHY';
  return {
    key: 'api', state,
    summary: state === 'HEALTHY'
      ? `Answering: ${t.responses} response(s), ${t.serverErrors} server error(s) in the last ${t.windowMinutes} min.`
      : `${t.serverErrors} of ${t.responses} response(s) were server errors in the last ${t.windowMinutes} min.`,
    measurements: {
      windowMinutes: t.windowMinutes,
      responses: t.responses,
      serverErrors: t.serverErrors,
      serverErrorRatio: round(ratio),
      responsesSinceStart: t.responsesSinceStart,
      serverErrorsSinceStart: t.serverErrorsSinceStart,
      lastResponseAt: t.lastResponseAt,
    },
    evidence: 'src/infra/api-traffic.ts — responses completed through the /api mount',
    measuredAt: iso(),
  };
}

/**
 * The build this process is running — TypeScript's only runtime status.
 *
 * TypeScript does not run; its output does. What a running server CAN prove is
 * that it is executing compiled JavaScript from a build whose compile step
 * succeeded: `npm run build` chains discovery, `tsc` and the asset copy with
 * `&&`, and the manifest is copied beside the compiled health service only by
 * that last step, so its presence there means `tsc` exited cleanly. A server
 * started from source through a transpiler cannot prove a type-checked build,
 * and says UNVERIFIED rather than green. Read once: a build cannot change under
 * a running process.
 */
let buildReading: { runtimeMode: 'compiled' | 'source'; buildCompleted: boolean } | null = null;

function buildSignal(): Signal {
  if (!buildReading) {
    const runtimeMode = __filename.endsWith('.js') ? 'compiled' : 'source';
    buildReading = {
      runtimeMode,
      buildCompleted: runtimeMode === 'compiled'
        && fs.existsSync(path.join(__dirname, 'generated', 'infrastructure-manifest.json')),
    };
  }
  const { runtimeMode, buildCompleted } = buildReading;
  const m = manifestOrNull();
  const compiler = m ? m.components.find((c) => c.id === 'typescript') : undefined;
  return {
    key: 'build',
    state: buildCompleted ? 'HEALTHY' : 'UNVERIFIED',
    summary: buildCompleted
      ? 'Running the compiled output of a build whose TypeScript compile completed.'
      : runtimeMode === 'source'
        ? 'Running TypeScript source through a transpiler; this process cannot prove a type-checked build.'
        : 'Running compiled output, but the build step that follows the compile left no marker beside it.',
    measurements: {
      runtimeMode,
      buildCompleted,
      typescriptVersion: compiler ? compiler.version : null,
      target: m && m.typescript && typeof m.typescript.target === 'string' ? m.typescript.target : null,
      manifestGeneratedAt: m ? m.generatedAt : null,
    },
    evidence: 'npm run build: infrastructure-discover && prisma generate && tsc && copy-runtime-assets',
    measuredAt: iso(),
  };
}

// ── components measured by the outcomes of their own operations ─────────────
//
// Each of these is fed from the call site that performs the operation — see
// `outcome-meter.ts` — so its state is what the component actually did in the
// last OUTCOME_WINDOW_MINUTES, not whether it is configured.
//
//   failures ≥ outcomeFailuresWarn and ≥ ratio      WARNING, CRITICAL at the higher ratio
//   …unless outcomeRecoveryStreak successes in a    HEALTHY — recovered, and says so; the
//    row have followed the last failure             failures stay in the measurements
//   operations in the window, below that            HEALTHY
//   idle window, last operation succeeded           HEALTHY, and says when
//   idle window, last operation failed              UNVERIFIED — nothing since shows recovery
//   never exercised since the process started       UNVERIFIED — nothing to judge yet
//
// UNVERIFIED is neutral: it never moves the overall status and is never
// published as a transition.

function outcomeSignal(key: string, channel: string, noun: string, evidence: string): Signal {
  const o = outcomeReading(channel);
  const total = o.ok + o.failed;
  const ratio = total > 0 ? o.failed / total : 0;
  const enough = o.failed >= THRESHOLDS.outcomeFailuresWarn;
  const recovered = o.okStreak >= THRESHOLDS.outcomeRecoveryStreak;
  let state: HealthState;
  let summary: string;
  if (enough && ratio >= THRESHOLDS.outcomeFailureRatioWarn && recovered) {
    state = 'HEALTHY';
    summary = `Recovered: the last ${o.okStreak} ${noun} succeeded after ${o.failed} failure(s) in the last ${o.windowMinutes} min.`;
  } else if (enough && ratio >= THRESHOLDS.outcomeFailureRatioCritical) {
    state = 'CRITICAL';
    summary = `${o.failed} of ${total} ${noun} failed in the last ${o.windowMinutes} min.`;
  } else if (enough && ratio >= THRESHOLDS.outcomeFailureRatioWarn) {
    state = 'WARNING';
    summary = `${o.failed} of ${total} ${noun} failed in the last ${o.windowMinutes} min.`;
  } else if (total > 0) {
    state = 'HEALTHY';
    summary = `${o.ok} of ${total} ${noun} succeeded in the last ${o.windowMinutes} min.`;
  } else if (o.lastOkAt && (!o.lastFailureAt || o.lastOkAt >= o.lastFailureAt)) {
    state = 'HEALTHY';
    summary = `No ${noun} in the last ${o.windowMinutes} min; the last one succeeded at ${o.lastOkAt}.`;
  } else if (o.lastFailureAt) {
    state = 'UNVERIFIED';
    summary = `The last of the ${noun} failed at ${o.lastFailureAt}, and none since shows recovery.`;
  } else {
    state = 'UNVERIFIED';
    summary = `No ${noun} since this process started, so there is nothing to judge yet.`;
  }
  return {
    key, state, summary,
    measurements: {
      windowMinutes: o.windowMinutes,
      succeeded: o.ok,
      failed: o.failed,
      failureRatio: round(ratio),
      succeededSinceStart: o.okSinceStart,
      failedSinceStart: o.failedSinceStart,
      lastSuccessAt: o.lastOkAt,
      lastFailureAt: o.lastFailureAt,
      successesSinceLastFailure: o.okStreak,
    },
    evidence,
    measuredAt: iso(),
  };
}

const outboxSignal = (): Signal => outcomeSignal('outbox', 'outbox', 'outbox appends',
  'src/fabric/event-bus.ts — every append to the durable outbox transport');
const authSignal = (): Signal => outcomeSignal('auth', 'auth', 'authentications',
  'src/middleware/auth.middleware.ts — sessions established vs server-side failures (a refused credential is not a failure)');
const rbacSignal = (): Signal => outcomeSignal('rbac', 'rbac', 'tenant-guard decisions',
  'src/middleware/tenant-guard.middleware.ts — guard decisions vs lookups that threw');
const auditChainSignal = (): Signal => outcomeSignal('auditChain', 'auditChain', 'audit-chain appends',
  'src/security/audit-chain.service.ts — appendAuditEvent() outcomes');
const metricsSignal = (): Signal => outcomeSignal('metrics', 'metrics', 'metric writes',
  'src/observability/metrics.service.ts — every metric and health-row write');
const monitoringSignal = (): Signal => outcomeSignal('monitoring', 'monitoring', 'recorded health checks',
  'src/monitoring/monitoring.service.ts — recordHealth() writes');
const loggingSignal = (): Signal => outcomeSignal('logging', 'logging', 'log writes',
  'src/utils/logger.ts — every winston transport `logged` and `error` event');
const sseSignal = (): Signal => outcomeSignal('sse', 'sse', 'live-stream tail reads',
  'src/routes/data-pulse.routes.ts — each tail poll of an open Data Pulse stream');

/** Anthropic: real call outcomes, and nothing when no key is configured. */
function anthropicSignal(): Signal {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      key: 'anthropic', state: 'NOT_CONFIGURED',
      summary: 'No Anthropic key is configured for this deployment, so no call is made.',
      measurements: { configured: false },
      evidence: 'presence of ANTHROPIC_API_KEY (name only; the value is never read)',
      measuredAt: iso(),
    };
  }
  return outcomeSignal('anthropic', 'anthropic', 'Anthropic calls',
    'src/services/ai.service.ts, ai-llm.adapter.ts, llm-adapter.service.ts — each messages.create()');
}

/**
 * Whether this host can run ffmpeg at all. Read once: a binary does not appear
 * or vanish under a running process. `FFMPEG_PATH` is what fluent-ffmpeg
 * honours; otherwise the PATH it would search.
 */
let ffmpegFound: string | null | undefined;
export function locateFfmpeg(): string | null {
  if (ffmpegFound !== undefined) return ffmpegFound;
  const candidates = process.env.FFMPEG_PATH
    ? [process.env.FFMPEG_PATH]
    : String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
      .map((d) => path.join(d, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
  ffmpegFound = null;
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); ffmpegFound = c; break; } catch (_) { /* next */ }
  }
  return ffmpegFound;
}
export function resetFfmpegLookup(): void { ffmpegFound = undefined; }

function mediaSignal(): Signal {
  if (!locateFfmpeg()) {
    return {
      key: 'media', state: 'NOT_CONFIGURED',
      summary: 'No ffmpeg binary is installed on this host, so no video can be transcoded here.',
      measurements: { ffmpegFound: false },
      evidence: 'FFMPEG_PATH, then an executable named ffmpeg on PATH',
      measuredAt: iso(),
    };
  }
  const sig = outcomeSignal('media', 'media', 'HLS transcode jobs',
    'src/services/video-hls.service.ts — transcodeToHls() outcomes');
  sig.measurements.ffmpegFound = true;
  return sig;
}

/** The two WebSocket servers, as mounted, with their live client counts. */
function webSocketSignal(): Signal {
  const servers = webSocketServers();
  if (!servers.length) {
    return {
      key: 'websockets', state: 'NOT_CONFIGURED',
      summary: 'No WebSocket server is mounted in this process.',
      measurements: { mounted: 0 },
      evidence: 'src/infra/ws-registry.ts — servers registered at mount',
      measuredAt: iso(),
    };
  }
  const o = outcomeReading(WS_CHANNEL);
  const total = o.ok + o.failed;
  const ratio = total > 0 ? o.failed / total : 0;
  const enough = o.failed >= THRESHOLDS.outcomeFailuresWarn && o.okStreak < THRESHOLDS.outcomeRecoveryStreak;
  const state: HealthState = enough && ratio >= THRESHOLDS.outcomeFailureRatioCritical ? 'CRITICAL'
    : enough && ratio >= THRESHOLDS.outcomeFailureRatioWarn ? 'WARNING' : 'HEALTHY';
  const clients = servers.reduce((n, x) => n + x.clients, 0);
  return {
    key: 'websockets', state,
    summary: state === 'HEALTHY'
      ? `${servers.length} server(s) mounted, ${clients} client(s) connected, ${o.failed} socket error(s) in the last ${o.windowMinutes} min.`
      : `${o.failed} socket error(s) against ${o.ok} connection(s) in the last ${o.windowMinutes} min.`,
    measurements: {
      mounted: servers.length,
      servers: servers.map((x) => x.name).join(', '),
      clients,
      connections: o.ok,
      errors: o.failed,
      windowMinutes: o.windowMinutes,
    },
    evidence: 'src/infra/ws-registry.ts — mounted servers, their clients, and every error event',
    measuredAt: iso(),
  };
}

/** The application-services layer: exceptions that reached the error reporter. */
function servicesSignal(): Signal {
  const t = apiTraffic();
  const ratio = t.responses > 0 ? t.unhandledErrors / t.responses : 0;
  const enough = t.unhandledErrors >= THRESHOLDS.apiServerErrorsWarn;
  const state: HealthState = enough && ratio >= THRESHOLDS.apiErrorRatioCritical ? 'CRITICAL'
    : enough && ratio >= THRESHOLDS.apiErrorRatioWarn ? 'WARNING' : 'HEALTHY';
  return {
    key: 'services', state,
    summary: `${t.unhandledErrors} unhandled server error(s) across ${t.responses} response(s) in the last ${t.windowMinutes} min.`,
    measurements: {
      windowMinutes: t.windowMinutes,
      responses: t.responses,
      unhandledErrors: t.unhandledErrors,
      unhandledRatio: round(ratio),
      unhandledSinceStart: t.unhandledSinceStart,
    },
    evidence: 'src/middleware/request-id.middleware.ts errorReporter → onError(), counted in src/infra/api-traffic.ts',
    measuredAt: iso(),
  };
}

/** HTTP hardening, checked on the responses that actually left. */
function httpHardeningSignal(): Signal {
  const t = apiTraffic();
  const state: HealthState = t.unhardened > 0 ? 'WARNING' : t.responses > 0 ? 'HEALTHY' : 'UNVERIFIED';
  return {
    key: 'httpHardening', state,
    summary: state === 'WARNING'
      ? `${t.unhardened} of ${t.responses} API response(s) left without hardening headers in the last ${t.windowMinutes} min.`
      : state === 'HEALTHY'
        ? `All ${t.responses} API response(s) in the last ${t.windowMinutes} min carried the hardening headers.`
        : `No API response has completed in the last ${t.windowMinutes} min to check.`,
    measurements: {
      windowMinutes: t.windowMinutes,
      responses: t.responses,
      unhardened: t.unhardened,
      unhardenedSinceStart: t.unhardenedSinceStart,
    },
    evidence: 'X-Content-Type-Options: nosniff (set by helmet) on each completed /api response',
    measuredAt: iso(),
  };
}

/** Rate limiting: the store the limiter really resolved, and whether it can use it. */
function rateLimitSignal(): Signal {
  const stats = rateLimitStats();
  const configured = redisConfigured();
  const redisHealthy = stats.store === 'redis' ? redisStatus().healthy : null;
  const state: HealthState = stats.store === 'redis'
    ? (redisHealthy ? 'HEALTHY' : 'WARNING')
    : configured ? 'WARNING' : 'HEALTHY';
  return {
    key: 'rateLimit', state,
    summary: stats.store === 'redis'
      ? (redisHealthy ? 'Limiting through Redis, shared across instances.'
        : 'Redis is unreachable; each request falls back to this process\'s memory, so limits are per-instance.')
      : configured
        ? 'Redis is configured but the limiter could not use it; limits are per-instance.'
        : 'Limiting in this process\'s memory store; no Redis is configured for this deployment.',
    measurements: {
      store: stats.store,
      redisConfigured: configured,
      redisHealthy,
      buckets: typeof stats.buckets === 'number' ? stats.buckets : null,
    },
    evidence: 'src/middleware/rate-limit.middleware.ts rateLimitStats(), src/infra/redis.ts redisStatus()',
    measuredAt: iso(),
  };
}

/** The Historical Query API: the read it serves, timed. */
async function historyQuerySignal(): Promise<Signal> {
  const started = Date.now();
  try {
    const w = await historyWindow();
    const latencyMs = Date.now() - started;
    const state: HealthState = latencyMs >= THRESHOLDS.dbLatencyCriticalMs ? 'CRITICAL'
      : latencyMs >= THRESHOLDS.dbLatencyWarnMs ? 'WARNING' : 'HEALTHY';
    return {
      key: 'historyQuery', state,
      summary: `The history window read answered in ${latencyMs} ms.`,
      measurements: { queryMs: latencyMs, storedEvents: w.total, warnMs: THRESHOLDS.dbLatencyWarnMs },
      evidence: 'src/fabric/history/history-query.service.ts historyWindow() — the read the API serves',
      measuredAt: iso(),
    };
  } catch (err) {
    return {
      key: 'historyQuery', state: 'CRITICAL',
      summary: 'The historical query could not be answered.',
      measurements: { queryMs: Date.now() - started },
      evidence: `historyWindow() failed: ${String((err as Error)?.message ?? '').slice(0, 120)}`,
      measuredAt: iso(),
    };
  }
}

// ── the files the static server hands to browsers ────────────────────────────

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

export const SERVED_ASSETS: { key: string; name: string; files: string[] }[] = [
  { key: 'webApp', name: 'the web application', files: ['index.html', 'app.js'] },
  { key: 'systemModule', name: 'the SYSTEM module', files: ['system/system.js'] },
  { key: 'dataVaultModule', name: 'the DATA VAULT module', files: ['data-vault/data-vault.js'] },
  { key: 'reactClient', name: 'the React client', files: ['app/index.html'] },
];

/**
 * A browser module is served if its files are on the disk express.static
 * serves from. Missing is CRITICAL: every request for that screen is a 404.
 * Rendering inside a browser is not measured here and is not claimed.
 */
export function assetSignal(a: { key: string; name: string; files: string[] }, root: string = PUBLIC_DIR): Signal {
  const missing: string[] = [];
  let bytes = 0;
  for (const f of a.files) {
    try {
      const st = fs.statSync(path.join(root, f));
      if (!st.isFile() || st.size === 0) missing.push(f);
      else bytes += st.size;
    } catch (_) { missing.push(f); }
  }
  return {
    key: a.key,
    state: missing.length ? 'CRITICAL' : 'HEALTHY',
    summary: missing.length
      ? `${missing.length} file(s) of ${a.name} are missing from the served directory: ${missing.join(', ')}.`
      : `Every file of ${a.name} is present in the served directory.`,
    measurements: { files: a.files.length, missing: missing.join(', ') || null, kilobytes: round(bytes / 1024) },
    evidence: `public/ — ${a.files.join(', ')}, served by express.static`,
    measuredAt: iso(),
  };
}

// ── the locale files every declared language needs ───────────────────────────

const parsedLocaleFiles = new Map<string, { stamp: string; ok: boolean }>();

function localeFileOk(file: string): boolean {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch (_) { return false; }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const seen = parsedLocaleFiles.get(file);
  if (seen && seen.stamp === stamp) return seen.ok;
  // Parsed once per version of the file, not once per health tick.
  let ok = false;
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); ok = !!v && typeof v === 'object'; } catch (_) { ok = false; }
  parsedLocaleFiles.set(file, { stamp, ok });
  return ok;
}

/**
 * Internationalisation: every locale the registry declares has a bundle and a
 * catalogue the browser can load. A broken locale falls back to English —
 * WARNING; a broken base locale leaves nothing to fall back to — CRITICAL.
 */
export function i18nSignal(root: string = PUBLIC_DIR): Signal {
  const broken: string[] = [];
  for (const l of LOCALES) {
    for (const kind of ['locales', 'catalogue']) {
      if (!localeFileOk(path.join(root, 'i18n', kind, `${l.tag}.json`))) broken.push(`${kind}/${l.tag}`);
    }
  }
  const baseBroken = broken.some((b) => b.endsWith(`/${DEFAULT_LOCALE}`));
  const state: HealthState = baseBroken ? 'CRITICAL' : broken.length ? 'WARNING' : 'HEALTHY';
  return {
    key: 'i18n', state,
    summary: broken.length
      ? `${broken.length} locale file(s) missing or unreadable: ${broken.slice(0, 6).join(', ')}${broken.length > 6 ? '…' : ''}.`
      : `All ${LOCALES.length} declared locales have a readable bundle and catalogue.`,
    measurements: { locales: LOCALES.length, broken: broken.length, brokenFiles: broken.join(', ') || null },
    evidence: 'src/i18n/locales.ts registry against public/i18n/locales and public/i18n/catalogue',
    measuredAt: iso(),
  };
}

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
        // An engine with no session store is a deployment that has not been
        // given evidence to read — an operator's configuration, not an outage —
        // so it is NOT_CONFIGURED, and nothing turns yellow over it.
        state: 'NOT_CONFIGURED',
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

/** Every signal, measured together. */
export async function infrastructureSignals(): Promise<Signal[]> {
  const [db, history, historyQuery, vision] = await Promise.all([
    databaseSignal(), historicalStoreSignal(), historyQuerySignal(), visionSignal(),
  ]);
  return [
    processSignal(), buildSignal(), apiSignal(), db, fabricSignal(), history, redisSignal(),
    objectStoreSignal(), archiveSignal(), aiSignal(),
    integrationSignal('stripe', 'STRIPE_SECRET_KEY', 'Stripe'),
    integrationSignal('email', 'SENDGRID_API_KEY', 'Email delivery'),
    deploymentSignal(), ciSignal(), testsSignal(), vision,
    historyQuery, servicesSignal(), httpHardeningSignal(), rateLimitSignal(),
    outboxSignal(), authSignal(), rbacSignal(), auditChainSignal(), anthropicSignal(),
    mediaSignal(), sseSignal(), webSocketSignal(), metricsSignal(), monitoringSignal(),
    loggingSignal(), i18nSignal(),
    ...SERVED_ASSETS.map((a) => assetSignal(a)),
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
    condition: `The writer's count of exhausted records (${THRESHOLDS.historyDroppedCritical} or more) rose within the last ${THRESHOLDS.counterWindowMinutes} minutes.`,
    nextStep: 'Inspect the historical writer. A dropped record is one the in-process queue gave up on; recovery may still deliver it from the outbox.',
    impact: 'History may be incomplete for the affected window.',
  },
  {
    id: 'history-failures', title: 'Historical write failures', severity: 'WARNING',
    componentId: 'historical-store', districtId: 'vault',
    condition: `The writer reports ${THRESHOLDS.historyFailuresWarn} or more failed writes, and they are still rising (last ${THRESHOLDS.counterWindowMinutes} minutes) or still waiting on a retry.`,
    nextStep: 'Check database health first — the writer fails when the store does.',
    impact: 'Affected events fall back to the durable outbox and are recovered later.',
  },
  {
    id: 'fabric-unknown', title: 'Unknown event types seen', severity: 'WARNING',
    componentId: 'data-fabric', districtId: 'fabric',
    condition: `The registry's count of unregistered event types (${THRESHOLDS.registryUnknownWarn} or more) rose within the last ${THRESHOLDS.counterWindowMinutes} minutes.`,
    nextStep: 'A producer is publishing a type the registry does not declare. Check recent producer changes.',
    impact: 'Unregistered events carry no schema and are classified defensively.',
  },
  {
    id: 'fabric-schema', title: 'Event schema failures', severity: 'WARNING',
    componentId: 'data-fabric', districtId: 'fabric',
    condition: `The registry's count of rejected payloads (${THRESHOLDS.registrySchemaFailWarn} or more) rose within the last ${THRESHOLDS.counterWindowMinutes} minutes.`,
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
    condition: `Heap used at or above ${Math.round(THRESHOLDS.heapUsedWarnRatio * 100)}% of the V8 heap limit (critical at ${Math.round(THRESHOLDS.heapUsedCriticalRatio * 100)}%).`,
    nextStep: 'Watch for a rising trend rather than a single reading; a garbage collection cycle moves this number.',
    impact: 'Sustained pressure precedes slowdowns and, eventually, a restart.',
  },
  {
    id: 'api-errors', title: 'API server errors elevated', severity: 'WARNING',
    componentId: 'api-gateway', districtId: 'backend',
    condition: `At least ${THRESHOLDS.apiServerErrorsWarn} server errors (5xx) and ${Math.round(THRESHOLDS.apiErrorRatioWarn * 100)}% of API responses in the last ${API_WINDOW_MINUTES} minutes (critical at ${Math.round(THRESHOLDS.apiErrorRatioCritical * 100)}%).`,
    nextStep: 'Search the structured log for http.error: each line names the route and carries the request id of the whole transaction.',
    impact: 'Requests on the affected routes are failing for the people making them.',
  },
  {
    id: 'object-store-volatile', title: 'Object storage is in-memory', severity: 'INFO',
    componentId: 'object-store', districtId: 'storage',
    condition: 'The object-storage port resolved to a memory store rather than a configured provider.',
    nextStep: 'Configure object storage before relying on media durability. Nothing written survives a restart.',
    impact: 'Stored objects are lost when the process restarts.',
  },
];

// Rules for components measured by the outcomes of their own operations. One
// shape, stated once: they fire while their signal is WARNING or CRITICAL.
const OUTCOME_CONDITION = `At least ${THRESHOLDS.outcomeFailuresWarn} failures and ${Math.round(THRESHOLDS.outcomeFailureRatioWarn * 100)}% of attempts in the last ${OUTCOME_WINDOW_MINUTES} minutes (critical at ${Math.round(THRESHOLDS.outcomeFailureRatioCritical * 100)}%), clearing after ${THRESHOLDS.outcomeRecoveryStreak} consecutive successes.`;

/** Which signal each component rule reads. The rule fires while that signal is WARNING or CRITICAL. */
export const SIGNAL_RULES: { signal: string; rule: string }[] = [
  { signal: 'webApp', rule: 'asset-web-app' },
  { signal: 'systemModule', rule: 'asset-system-module' },
  { signal: 'dataVaultModule', rule: 'asset-data-vault-module' },
  { signal: 'reactClient', rule: 'asset-react-client' },
  { signal: 'services', rule: 'service-errors' },
  { signal: 'outbox', rule: 'outbox-append-failing' },
  { signal: 'historyQuery', rule: 'history-query-failing' },
  { signal: 'auth', rule: 'auth-failing' },
  { signal: 'rbac', rule: 'rbac-lookups-failing' },
  { signal: 'rateLimit', rule: 'rate-limit-degraded' },
  { signal: 'auditChain', rule: 'audit-chain-failing' },
  { signal: 'httpHardening', rule: 'http-hardening-missing' },
  { signal: 'anthropic', rule: 'ai-provider-failing' },
  { signal: 'media', rule: 'media-transcode-failing' },
  { signal: 'sse', rule: 'sse-tail-failing' },
  { signal: 'websockets', rule: 'websocket-errors' },
  { signal: 'metrics', rule: 'metrics-writes-failing' },
  { signal: 'monitoring', rule: 'monitoring-writes-failing' },
  { signal: 'logging', rule: 'logging-transport-failing' },
  { signal: 'i18n', rule: 'i18n-locale-broken' },
];

const COMPONENT_RULES: InfraRule[] = [
  {
    id: 'asset-web-app', title: 'Web application files missing', severity: 'CRITICAL',
    componentId: 'web-app', districtId: 'frontend',
    condition: 'public/index.html or public/app.js is missing or empty on the disk the static server serves.',
    nextStep: 'Check the deploy artefact: the build did not ship the web application.',
    impact: 'Nobody can load the signed-in workspace.',
  },
  {
    id: 'asset-system-module', title: 'SYSTEM module files missing', severity: 'WARNING',
    componentId: 'system-module', districtId: 'frontend',
    condition: 'public/system/system.js is missing or empty on the served disk.',
    nextStep: 'Check the deploy artefact for public/system/.',
    impact: 'The SYSTEM screens return 404.',
  },
  {
    id: 'asset-data-vault-module', title: 'DATA VAULT module files missing', severity: 'WARNING',
    componentId: 'data-vault-module', districtId: 'frontend',
    condition: 'public/data-vault/data-vault.js is missing or empty on the served disk.',
    nextStep: 'Check the deploy artefact for public/data-vault/.',
    impact: 'The Data Vault screens return 404.',
  },
  {
    id: 'asset-react-client', title: 'React client build missing', severity: 'WARNING',
    componentId: 'react-client', districtId: 'frontend',
    condition: 'public/app/index.html is missing or empty on the served disk.',
    nextStep: 'Rebuild the client (npm run build:client) and redeploy.',
    impact: 'Everything under /app returns the fallback rather than the client.',
  },
  {
    id: 'service-errors', title: 'Application service errors elevated', severity: 'WARNING',
    componentId: 'backend-services', districtId: 'backend',
    condition: `At least ${THRESHOLDS.apiServerErrorsWarn} unhandled server errors and ${Math.round(THRESHOLDS.apiErrorRatioWarn * 100)}% of API responses in the last ${API_WINDOW_MINUTES} minutes (critical at ${Math.round(THRESHOLDS.apiErrorRatioCritical * 100)}%).`,
    nextStep: 'Search the structured log for http.error; the request id leads to the failing service call.',
    impact: 'Requests reaching the failing services end in a server error.',
  },
  {
    id: 'outbox-append-failing', title: 'Durable outbox appends failing', severity: 'CRITICAL',
    componentId: 'durable-outbox', districtId: 'fabric',
    condition: OUTCOME_CONDITION,
    nextStep: 'Check database health first; the outbox is a table, and it fails when the store does.',
    impact: 'Events that fail to append are not durable and will not reach history.',
  },
  {
    id: 'history-query-failing', title: 'Historical queries failing', severity: 'WARNING',
    componentId: 'history-api', districtId: 'vault',
    condition: `The history window read failed, or took ${THRESHOLDS.dbLatencyWarnMs} ms or more (critical at ${THRESHOLDS.dbLatencyCriticalMs} ms).`,
    nextStep: 'Check the database and the FabricEventHistory indexes.',
    impact: 'The Data Vault cannot answer history reads, or answers them slowly.',
  },
  {
    id: 'auth-failing', title: 'Authentication failing server-side', severity: 'WARNING',
    componentId: 'authentication', districtId: 'security',
    condition: `${OUTCOME_CONDITION} Refused credentials are not failures.`,
    nextStep: 'Check the identity lookup and the database; a token that verifies but cannot be resolved fails here.',
    impact: 'Signed-in people are turned away with server errors.',
  },
  {
    id: 'rbac-lookups-failing', title: 'Tenant guard lookups failing', severity: 'WARNING',
    componentId: 'rbac', districtId: 'security',
    condition: OUTCOME_CONDITION,
    nextStep: 'The guard fails open to the service checks behind it; check the database and the guard\'s security events.',
    impact: 'Defence-in-depth tenant checks are being skipped; service-level checks still apply.',
  },
  {
    id: 'rate-limit-degraded', title: 'Rate limiting degraded to per-instance', severity: 'WARNING',
    componentId: 'rate-limiting', districtId: 'security',
    condition: 'Redis is configured but the limiter is not using it, or Redis is unreachable and the limiter is falling back to memory.',
    nextStep: 'Restore Redis; limits recover as soon as it answers.',
    impact: 'Limits are enforced per instance rather than across the platform.',
  },
  {
    id: 'audit-chain-failing', title: 'Security audit appends failing', severity: 'WARNING',
    componentId: 'security-audit', districtId: 'security',
    condition: OUTCOME_CONDITION,
    nextStep: 'Check the database and the chain head; a failed append is an audit event the chain does not hold.',
    impact: 'Security-relevant actions are going unrecorded.',
  },
  {
    id: 'http-hardening-missing', title: 'Responses leaving without hardening headers', severity: 'WARNING',
    componentId: 'http-hardening', districtId: 'security',
    condition: `One or more API responses in the last ${API_WINDOW_MINUTES} minutes left without X-Content-Type-Options: nosniff.`,
    nextStep: 'Check that helmet is still mounted ahead of the API router in src/app.ts.',
    impact: 'Browsers receive API responses without the platform\'s security headers.',
  },
  {
    id: 'ai-provider-failing', title: 'Anthropic calls failing', severity: 'WARNING',
    componentId: 'anthropic', districtId: 'ai',
    condition: OUTCOME_CONDITION,
    nextStep: 'Check the provider status and the key; rate limits and timeouts count as failures.',
    impact: 'AI features answer with errors or fall back.',
  },
  {
    id: 'media-transcode-failing', title: 'Video transcodes failing', severity: 'WARNING',
    componentId: 'media-pipeline', districtId: 'storage',
    condition: OUTCOME_CONDITION,
    nextStep: 'Check ffmpeg on the host and object storage reads and writes.',
    impact: 'Uploaded video is not becoming playable.',
  },
  {
    id: 'sse-tail-failing', title: 'Live stream reads failing', severity: 'WARNING',
    componentId: 'sse-stream', districtId: 'realtime',
    condition: OUTCOME_CONDITION,
    nextStep: 'The Data Pulse tail reads the outbox; check the database.',
    impact: 'Open live boards stop receiving events.',
  },
  {
    id: 'websocket-errors', title: 'WebSocket errors elevated', severity: 'WARNING',
    componentId: 'websockets', districtId: 'realtime',
    condition: `${OUTCOME_CONDITION} Connections count as successes; server and socket error events as failures.`,
    nextStep: 'Check the upgrade path and the proxy in front of the service.',
    impact: 'Live match and market channels are dropping.',
  },
  {
    id: 'metrics-writes-failing', title: 'Metric writes failing', severity: 'WARNING',
    componentId: 'metrics', districtId: 'monitoring',
    condition: OUTCOME_CONDITION,
    nextStep: 'Metric writes go to the database; check it first.',
    impact: 'Operational metrics are missing for the affected window.',
  },
  {
    id: 'monitoring-writes-failing', title: 'Health check records failing', severity: 'WARNING',
    componentId: 'monitoring', districtId: 'monitoring',
    condition: OUTCOME_CONDITION,
    nextStep: 'Recorded health checks go to the database; check it first.',
    impact: 'Reported health checks are not being kept.',
  },
  {
    id: 'logging-transport-failing', title: 'Log transport errors', severity: 'WARNING',
    componentId: 'logging', districtId: 'monitoring',
    condition: OUTCOME_CONDITION,
    nextStep: 'A transport could not write — usually a file it cannot append to. Check disk and permissions.',
    impact: 'Log lines are being lost.',
  },
  {
    id: 'i18n-locale-broken', title: 'Locale files missing or unreadable', severity: 'WARNING',
    componentId: 'i18n', districtId: 'i18n',
    condition: 'A locale the registry declares has no readable bundle or catalogue (critical when it is the base locale).',
    nextStep: 'Run npm run i18n:check and redeploy the missing files.',
    impact: 'Readers of that language see English instead.',
  },
];

INFRASTRUCTURE_RULES.push(...COMPONENT_RULES);

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

  if (hist.droppedActive === true) {
    fire(ruleById('history-dropped')!, `${hist.dropped} record(s) exhausted their retries.`, hist);
  } else { clear('history-dropped'); }

  if (hist.writeFailuresActive === true) {
    fire(ruleById('history-failures')!, `${hist.writeFailures} historical write(s) failed since start.`, hist);
  } else { clear('history-failures'); }

  const fab = m('fabric');
  if (fab.unknownEventsActive === true) {
    fire(ruleById('fabric-unknown')!, `${fab.unknownEventCount} unregistered event type(s) seen.`, fab);
  } else { clear('fabric-unknown'); }

  if (fab.schemaFailuresActive === true) {
    fire(ruleById('fabric-schema')!, `${fab.schemaFailureCount} payload(s) rejected by their own schema.`, fab);
  } else { clear('fabric-schema'); }

  if (state('api') === 'WARNING' || state('api') === 'CRITICAL') {
    const api = m('api');
    fire(ruleById('api-errors')!, `${api.serverErrors} of ${api.responses} API response(s) were server errors in the last ${api.windowMinutes} min.`, api);
  } else { clear('api-errors'); }

  if (state('redis') === 'CRITICAL') {
    fire(ruleById('redis-down')!, 'Redis is configured but the client is not connected.', m('redis'));
  } else { clear('redis-down'); }

  const proc = m('process');
  if (state('process') === 'WARNING' || state('process') === 'CRITICAL') {
    fire(ruleById('heap-pressure')!, `Heap at ${Math.round(Number(proc.heapRatio ?? 0) * 100)}% of the ${proc.heapLimitMb} MB V8 heap limit.`, proc);
  } else { clear('heap-pressure'); }

  for (const { signal, rule } of SIGNAL_RULES) {
    const st = state(signal);
    const sig = by.get(signal);
    if ((st === 'WARNING' || st === 'CRITICAL') && sig) fire(ruleById(rule)!, sig.summary, sig.measurements);
    else clear(rule);
  }

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
  counterRises.clear();
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
