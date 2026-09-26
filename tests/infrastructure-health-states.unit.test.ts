/**
 * Infrastructure City — what may turn the city yellow or red, and what may not
 *
 * The city once showed a platform-wide Warning, and Node.js and the Platform
 * Core Critical, on a healthy fifty-megabyte process: heap pressure was read as
 * `heapUsed / heapTotal`, and `heapTotal` is only what V8 has committed so far,
 * so that ratio sits above 90% in any healthy server. Three buildings were also
 * joined to health keys no signal answered, so the topology drew them UNKNOWN.
 *
 * These tests pin the corrected contract:
 *
 *   · heap pressure is judged against the V8 heap LIMIT;
 *   · every health key the manifest names is answered by a live signal;
 *   · the API router reports the server errors it actually returned;
 *   · a since-start counter raises a warning while it is RISING, and stops once
 *     the thing recovered;
 *   · NOT_CONFIGURED, NOT_INSTRUMENTED, UNVERIFIED and FUTURE never move the
 *     overall status — only a real operational fault does.
 */

import fs from 'fs';
import path from 'path';
import v8 from 'v8';

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'src/infra/generated/infrastructure-manifest.json');
const ROUTES_TS = path.join(ROOT, 'src/routes/infrastructure.routes.ts');
const HEALTH_TS = path.join(ROOT, 'src/infra/infrastructure-health.service.ts');

// ── the platform around the health layer, held still ────────────────────────

const writer = { failures: 0, dropped: 0, retryBacklog: 0 };
const registry = { unknownEventCount: 0, schemaFailureCount: 0 };
let dbUp = true;
let visionSessions: unknown = [];

jest.mock('../src/config/database', () => ({
  prisma: {
    $queryRaw: async () => {
      if (!dbUp) throw new Error('connect ECONNREFUSED');
      return [{ '?column?': 1 }];
    },
  },
}));
jest.mock('../src/fabric/producers/system.producer', () => ({
  publishSystemHealthChanged: () => undefined,
}));
jest.mock('../src/fabric/history/history-writer.service', () => ({
  fabricHistoryHealth: () => ({
    state: writer.dropped > 0 || writer.retryBacklog > 0 ? 'DEGRADED' : 'HEALTHY',
    written: 10, duplicates: 0, failures: writer.failures, dropped: writer.dropped,
    retryBacklog: writer.retryBacklog, lastWriteAt: null, lastError: null, scope: 'PROCESS',
  }),
}));
jest.mock('../src/fabric/history/history-recovery.service', () => ({
  historyRecoveryHealth: () => ({ enabled: true, totalRecovered: 0 }),
  pendingHistoryDelivery: async () => ({ examined: 0, pending: 0, window: { since: '', until: '' } }),
}));
jest.mock('../src/fabric/history/history-query.service', () => ({
  historyWindow: async () => ({ total: 10, earliest: null }),
}));
jest.mock('../src/fabric/registry/unknown-events', () => ({
  registryHealth: () => ({ ...registry, unknownEventTypes: [], schemaFailureTypes: [], quarantinedCount: 0 }),
}));
jest.mock('../src/vision-platform/engine-contract', () => ({
  visionEngine: () => ({
    identify: async () => ({ status: 'READY', deviceKind: 'SERVER' }),
    listSessions: async () => visionSessions,
  }),
  isUnavailable: (v: unknown) => !!v && typeof v === 'object' && 'reason' in (v as Record<string, unknown>),
  configuredTarget: () => 'LOCAL_SERVER',
}));
jest.mock('../src/vision-platform/vision-events', () => ({ visionEventCatalogue: () => [] }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const health = require('../src/infra/infrastructure-health.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const traffic = require('../src/infra/api-traffic');

type Sig = { key: string; state: string; summary: string; measurements: Record<string, unknown> };
const byKey = (signals: Sig[]) => Object.fromEntries(signals.map((s) => [s.key, s])) as Record<string, Sig>;
const MIN = 60_000;

let now = Date.parse('2026-09-26T12:00:00Z');
beforeEach(() => {
  writer.failures = 0; writer.dropped = 0; writer.retryBacklog = 0;
  registry.unknownEventCount = 0; registry.schemaFailureCount = 0;
  dbUp = true;
  visionSessions = [];
  now += 24 * 60 * MIN;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  health.resetInfrastructureIncidents();
  traffic.resetApiTraffic();
});
afterEach(() => jest.restoreAllMocks());

function fakeHeap(usedMb: number, committedMb: number, limitMb: number): void {
  const MB = 1048576;
  jest.spyOn(process, 'memoryUsage').mockReturnValue({
    rss: (committedMb + 40) * MB, heapTotal: committedMb * MB, heapUsed: usedMb * MB, external: 0, arrayBuffers: 0,
  } as NodeJS.MemoryUsage);
  jest.spyOn(v8, 'getHeapStatistics').mockReturnValue({ heap_size_limit: limitMb * MB } as v8.HeapInfo);
}

describe('heap pressure is judged against the V8 heap limit', () => {
  it('reads a nearly full COMMITTED heap on a small process as healthy — the false alarm that lit the city', async () => {
    fakeHeap(50, 53, 4096);                              // 94% of committed, 1% of the limit
    const h = await health.infrastructureHealth();
    const proc = byKey(h.signals).process;
    expect(proc.state).toBe('HEALTHY');
    expect(proc.measurements.heapRatio).toBe(0.01);
    expect(proc.measurements.heapLimitMb).toBe(4096);
    expect(h.incidents.map((i: { ruleId: string }) => i.ruleId)).not.toContain('heap-pressure');
  });

  it('still raises heap pressure when the heap really is near its limit', async () => {
    fakeHeap(3600, 3700, 4096);                          // 88% of the limit
    const warn = await health.infrastructureHealth();
    expect(byKey(warn.signals).process.state).toBe('WARNING');
    expect(warn.incidents.map((i: { ruleId: string }) => i.ruleId)).toContain('heap-pressure');
    expect(warn.overall).toBe('WARNING');

    fakeHeap(4000, 4050, 4096);                          // 98% of the limit
    expect(byKey((await health.infrastructureHealth()).signals).process.state).toBe('CRITICAL');
  });

  it('draws the capacity bar against the same limit the rule uses', () => {
    const city = fs.readFileSync(path.join(ROOT, 'public/infrastructure-city/infrastructure-city.js'), 'utf8');
    expect(city).toContain("bar('Process heap', proc.heapUsedMb, proc.heapLimitMb, 'MB')");
  });
});

describe('every building is joined to a signal that exists', () => {
  it('answers every health key the manifest names, so no building is drawn UNKNOWN for want of a join', async () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const keys = new Set((await health.infrastructureSignals()).map((s: Sig) => s.key));
    const dangling = manifest.components
      .filter((c: { healthKey: string | null }) => c.healthKey && !keys.has(c.healthKey))
      .map((c: { id: string; healthKey: string }) => `${c.id} → ${c.healthKey}`);
    expect(dangling).toEqual([]);
  });

  it('joins the Languages & Runtime district to real readings: the build for TypeScript, the process for Node.js', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const lang = Object.fromEntries(manifest.components
      .filter((c: { district: string }) => c.district === 'language')
      .map((c: { id: string; healthKey: string }) => [c.id, c.healthKey]));
    expect(lang).toEqual({ typescript: 'build', nodejs: 'process' });
  });

  it('reads a server started from source as UNVERIFIED rather than green, and never as a fault', async () => {
    // Under ts-jest this module is TypeScript source, exactly like `npm run dev`.
    const build = byKey(await health.infrastructureSignals()).build;
    expect(build.state).toBe('UNVERIFIED');
    expect(build.measurements.runtimeMode).toBe('source');
  });

  it('calls a key no signal answers NOT_INSTRUMENTED in the topology, the word the city already uses', () => {
    const routes = fs.readFileSync(ROUTES_TS, 'utf8');
    expect(routes).toContain("health: (c.healthKey && byKey.get(c.healthKey)?.state) || 'NOT_INSTRUMENTED'");
    expect(routes).not.toContain("?? 'UNKNOWN'");
  });
});

describe('the API router reports the errors it actually returned', () => {
  it('counts only completed responses inside the window, and forgets them after it', () => {
    for (let i = 0; i < 8; i += 1) traffic.recordApiResponse(200, now);
    traffic.recordApiResponse(503, now);
    expect(traffic.apiTraffic(now)).toMatchObject({ responses: 9, serverErrors: 1, responsesSinceStart: 9 });
    const later = now + (traffic.API_WINDOW_MINUTES + 1) * MIN;
    expect(traffic.apiTraffic(later)).toMatchObject({ responses: 0, serverErrors: 0, responsesSinceStart: 9 });
  });

  it('is healthy when the router is answering, including with client errors', async () => {
    for (let i = 0; i < 30; i += 1) traffic.recordApiResponse(i % 3 === 0 ? 404 : 200, now);
    const h = await health.infrastructureHealth();
    expect(byKey(h.signals).api.state).toBe('HEALTHY');
    expect(h.overall).toBe('HEALTHY');
  });

  it('does not call a handful of errors on a quiet platform an outage', async () => {
    for (let i = 0; i < 3; i += 1) traffic.recordApiResponse(500, now);
    expect(byKey(await health.infrastructureSignals()).api.state).toBe('HEALTHY');
  });

  it('raises a warning on the API Router when server errors are a real share of traffic', async () => {
    for (let i = 0; i < 40; i += 1) traffic.recordApiResponse(i < 6 ? 500 : 200, now);   // 15%
    const h = await health.infrastructureHealth();
    expect(byKey(h.signals).api.state).toBe('WARNING');
    const inc = h.incidents.find((i: { ruleId: string }) => i.ruleId === 'api-errors');
    expect(inc).toMatchObject({ componentId: 'api-gateway', districtId: 'backend', severity: 'WARNING' });
    expect(h.overall).toBe('WARNING');

    for (let i = 0; i < 20; i += 1) traffic.recordApiResponse(502, now);                 // 43%
    expect(byKey(await health.infrastructureSignals()).api.state).toBe('CRITICAL');
  });
});

describe('a since-start counter warns while it is rising, and not for ever', () => {
  it('opens a historical write incident on new failures and resolves it once the writer recovered', async () => {
    writer.failures = 2;
    let h = await health.infrastructureHealth();
    expect(byKey(h.signals).historicalStore.state).toBe('WARNING');
    expect(h.incidents.map((i: { ruleId: string }) => i.ruleId)).toContain('history-failures');

    now += (health.THRESHOLDS.counterWindowMinutes + 1) * MIN;
    h = await health.infrastructureHealth();
    const store = byKey(h.signals).historicalStore;
    expect(store.state).toBe('HEALTHY');
    expect(store.measurements.writeFailures).toBe(2);           // the total is still reported
    expect(h.overall).toBe('HEALTHY');
    expect(health.resolvedIncidents().map((i: { ruleId: string }) => i.ruleId)).toContain('history-failures');
  });

  it('keeps the incident open while records are still waiting on a retry', async () => {
    writer.failures = 2; writer.retryBacklog = 3;
    await health.infrastructureHealth();
    now += (health.THRESHOLDS.counterWindowMinutes + 1) * MIN;
    const h = await health.infrastructureHealth();
    expect(byKey(h.signals).historicalStore.state).toBe('WARNING');
    expect(h.incidents.map((i: { ruleId: string }) => i.ruleId)).toContain('history-failures');
  });

  it('re-opens when the counter rises again', async () => {
    registry.unknownEventCount = 1;
    expect((await health.infrastructureHealth()).overall).toBe('WARNING');
    now += (health.THRESHOLDS.counterWindowMinutes + 1) * MIN;
    expect((await health.infrastructureHealth()).overall).toBe('HEALTHY');
    registry.unknownEventCount = 2;
    const h = await health.infrastructureHealth();
    expect(h.overall).toBe('WARNING');
    expect(h.incidents.map((i: { ruleId: string }) => i.ruleId)).toContain('fabric-unknown');
  });

  it('treats dropped records as critical while drops are happening', async () => {
    writer.dropped = 1;
    const h = await health.infrastructureHealth();
    expect(byKey(h.signals).historicalStore.state).toBe('CRITICAL');
    expect(h.overall).toBe('CRITICAL');
  });
});

describe('only a real operational fault moves the overall status', () => {
  it('is HEALTHY while optional parts are unconfigured, uninstrumented or unverifiable', async () => {
    const h = await health.infrastructureHealth();
    const states = new Set(h.signals.map((s: Sig) => s.state));
    // The neutral words are all present in this frame…
    expect(states).toContain('NOT_CONFIGURED');
    expect(states).toContain('NOT_INSTRUMENTED');
    expect(states).toContain('UNVERIFIED');
    // …and none of them is a fault.
    expect(h.signals.filter((s: Sig) => s.state === 'WARNING' || s.state === 'CRITICAL')).toEqual([]);
    expect(h.incidents.filter((i: { severity: string }) => i.severity !== 'INFO')).toEqual([]);
    expect(h.overall).toBe('HEALTHY');
  });

  it('is not hard-coded: a database that stops answering turns the city critical', async () => {
    dbUp = false;
    const h = await health.infrastructureHealth();
    expect(byKey(h.signals).database.state).toBe('CRITICAL');
    expect(h.incidents.map((i: { ruleId: string }) => i.ruleId)).toContain('db-unreachable');
    expect(h.overall).toBe('CRITICAL');
  });

  it('reads a Vision deployment with no session store as a setting, not a warning', async () => {
    visionSessions = { status: 'UNAVAILABLE', reason: 'no store' };
    expect(byKey(await health.infrastructureSignals()).vision.state).toBe('NOT_CONFIGURED');
  });

  it('keeps planned plots neutral in the city, below every measured state', () => {
    const city = fs.readFileSync(path.join(ROOT, 'public/infrastructure-city/infrastructure-city.js'), 'utf8');
    expect(city).toContain("if (c.status === 'FUTURE') return 'FUTURE';");
    expect(city).toMatch(/NOT_INSTRUMENTED: 6, FUTURE: 7 \}/);
    expect(city).toContain("case 'FUTURE': return 'future';");
  });

  it('never decides the overall status from anything but incidents and unreadable signals', () => {
    const src = fs.readFileSync(HEALTH_TS, 'utf8');
    const block = src.slice(src.indexOf('export async function infrastructureHealth'));
    expect(block).toContain("overall: critical > 0 ? 'CRITICAL' : warning > 0 ? 'WARNING'");
    expect(block).not.toMatch(/overall:\s*'HEALTHY'/);
  });
});
