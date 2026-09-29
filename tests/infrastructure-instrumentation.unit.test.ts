/**
 * Infrastructure City — every implemented component reads a real signal
 *
 * Each building the city draws for a component that exists in this build now
 * derives its state from something the running platform measures: the outcome
 * of the operation the component performs, the files it serves, the store it
 * resolved, the servers it mounted. These tests drive every one of those
 * signals through the same three steps:
 *
 *   idle      → neutral (UNVERIFIED / NOT_CONFIGURED), never green on no evidence
 *   failure   → WARNING or CRITICAL, with that component's incident opened
 *   recovery  → HEALTHY, with the incident resolved and kept
 *
 * and pin the six components that honestly have no production signal yet.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'src/infra/generated/infrastructure-manifest.json');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── the platform around the health layer, held still ────────────────────────

let historyReadFails = false;
const limiter = { store: 'memory' as 'memory' | 'redis' };
const redis = { configured: false, healthy: false };

jest.mock('../src/config/database', () => ({ prisma: { $queryRaw: async () => [{ '?column?': 1 }] } }));
jest.mock('../src/fabric/producers/system.producer', () => ({ publishSystemHealthChanged: () => undefined }));
jest.mock('../src/fabric/history/history-writer.service', () => ({
  fabricHistoryHealth: () => ({ state: 'HEALTHY', written: 1, duplicates: 0, failures: 0, dropped: 0, retryBacklog: 0 }),
}));
jest.mock('../src/fabric/history/history-recovery.service', () => ({
  historyRecoveryHealth: () => ({ enabled: true, totalRecovered: 0 }),
  pendingHistoryDelivery: async () => ({ examined: 0, pending: 0 }),
}));
jest.mock('../src/fabric/history/history-query.service', () => ({
  historyWindow: async () => {
    if (historyReadFails) throw new Error('relation does not exist');
    return { total: 10, earliest: null };
  },
}));
jest.mock('../src/fabric/registry/unknown-events', () => ({
  registryHealth: () => ({ unknownEventCount: 0, schemaFailureCount: 0 }),
}));
jest.mock('../src/infra/redis', () => ({
  redisConfigured: () => redis.configured,
  redisStatus: () => ({ healthy: redis.healthy, everConnected: redis.healthy, outages: 0, lastOutageAt: null }),
}));
jest.mock('../src/middleware/rate-limit.middleware', () => ({
  rateLimitStats: () => ({ store: limiter.store, buckets: limiter.store === 'memory' ? 4 : 'n/a' }),
}));
jest.mock('../src/vision-platform/engine-contract', () => ({
  visionEngine: () => ({ identify: async () => ({ status: 'READY' }), listSessions: async () => [] }),
  isUnavailable: () => false,
  configuredTarget: () => 'LOCAL_SERVER',
}));
jest.mock('../src/vision-platform/vision-events', () => ({ visionEventCatalogue: () => [] }));

/* eslint-disable @typescript-eslint/no-var-requires */
const health = require('../src/infra/infrastructure-health.service');
const outcomes = require('../src/infra/outcome-meter');
const traffic = require('../src/infra/api-traffic');
const wsRegistry = require('../src/infra/ws-registry');
/* eslint-enable @typescript-eslint/no-var-requires */

type Sig = { key: string; state: string; summary: string; measurements: Record<string, unknown> };
type Inc = { ruleId: string; componentId: string; severity: string };
const MIN = 60_000;
const signalOf = async (key: string): Promise<Sig> =>
  (await health.infrastructureSignals()).find((s: Sig) => s.key === key);
const openRules = (h: { incidents: Inc[] }) => h.incidents.map((i) => i.ruleId);
const resolvedRules = () => health.resolvedIncidents().map((i: Inc) => i.ruleId);

let now = Date.parse('2026-09-27T12:00:00Z');
const savedEnv = { ...process.env };
beforeEach(() => {
  now += 24 * 60 * MIN;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  health.resetInfrastructureIncidents();
  outcomes.resetOutcomes();
  traffic.resetApiTraffic();
  wsRegistry.resetWebSocketRegistry();
  health.resetFfmpegLookup();
  historyReadFails = false;
  limiter.store = 'memory';
  redis.configured = false; redis.healthy = false;
  process.env = { ...savedEnv };
});
afterEach(() => { jest.restoreAllMocks(); process.env = { ...savedEnv }; });

const record = (channel: string, ok: number, failed: number) => {
  for (let i = 0; i < ok; i += 1) outcomes.recordOutcome(channel, true, now);
  for (let i = 0; i < failed; i += 1) outcomes.recordOutcome(channel, false, now);
};

// ── the outcome-measured components ──────────────────────────────────────────

const OUTCOME_COMPONENTS: { signal: string; channel: string; rule: string; component: string; setup?: () => void }[] = [
  { signal: 'outbox', channel: 'outbox', rule: 'outbox-append-failing', component: 'durable-outbox' },
  { signal: 'auth', channel: 'auth', rule: 'auth-failing', component: 'authentication' },
  { signal: 'rbac', channel: 'rbac', rule: 'rbac-lookups-failing', component: 'rbac' },
  { signal: 'auditChain', channel: 'auditChain', rule: 'audit-chain-failing', component: 'security-audit' },
  { signal: 'metrics', channel: 'metrics', rule: 'metrics-writes-failing', component: 'metrics' },
  { signal: 'monitoring', channel: 'monitoring', rule: 'monitoring-writes-failing', component: 'monitoring' },
  { signal: 'logging', channel: 'logging', rule: 'logging-transport-failing', component: 'logging' },
  { signal: 'sse', channel: 'sse', rule: 'sse-tail-failing', component: 'sse-stream' },
  { signal: 'anthropic', channel: 'anthropic', rule: 'ai-provider-failing', component: 'anthropic',
    setup: () => { process.env.ANTHROPIC_API_KEY = 'present-for-test'; } },
  { signal: 'media', channel: 'media', rule: 'media-transcode-failing', component: 'media-pipeline',
    setup: () => { process.env.FFMPEG_PATH = process.execPath; } },
];

describe.each(OUTCOME_COMPONENTS)('$component reads the outcomes of its own operations', (c) => {
  beforeEach(() => { c.setup?.(); });

  it('is UNVERIFIED — not green — before it has done anything, and raises nothing', async () => {
    const s = await signalOf(c.signal);
    expect(s.state).toBe('UNVERIFIED');
    const h = await health.infrastructureHealth();
    expect(openRules(h)).not.toContain(c.rule);
  });

  it('goes WARNING, then CRITICAL, on real failures, and opens its own incident', async () => {
    record(c.channel, 9, 3);                                   // 25%
    let h = await health.infrastructureHealth();
    expect(h.signals.find((s: Sig) => s.key === c.signal).state).toBe('WARNING');
    const inc = h.incidents.find((i: Inc) => i.ruleId === c.rule);
    expect(inc).toMatchObject({ componentId: c.component });

    record(c.channel, 0, 10);                                  // 13 of 22
    h = await health.infrastructureHealth();
    expect(h.signals.find((s: Sig) => s.key === c.signal).state).toBe('CRITICAL');
    expect(h.overall).toBe(inc.severity);
  });

  it('does not call a single failure an incident', async () => {
    record(c.channel, 0, 2);
    const s = await signalOf(c.signal);
    expect(['HEALTHY', 'UNVERIFIED']).toContain(s.state);
  });

  it('recovers to HEALTHY once failures leave the window and operations succeed, and keeps the incident', async () => {
    record(c.channel, 1, 5);
    expect(openRules(await health.infrastructureHealth())).toContain(c.rule);

    now += (outcomes.OUTCOME_WINDOW_MINUTES + 1) * MIN;
    record(c.channel, 4, 0);
    const h = await health.infrastructureHealth();
    expect(h.signals.find((s: Sig) => s.key === c.signal).state).toBe('HEALTHY');
    expect(openRules(h)).not.toContain(c.rule);
    expect(resolvedRules()).toContain(c.rule);
  });

  it('recovers as soon as operations succeed in a row, without waiting out the window', async () => {
    record(c.channel, 1, 6);
    expect(openRules(await health.infrastructureHealth())).toContain(c.rule);

    record(c.channel, health.THRESHOLDS.outcomeRecoveryStreak - 1, 0);
    expect((await signalOf(c.signal)).state).not.toBe('HEALTHY');   // not yet: one short

    record(c.channel, 1, 0);
    const h = await health.infrastructureHealth();
    const s = h.signals.find((x: Sig) => x.key === c.signal);
    expect(s.state).toBe('HEALTHY');
    expect(s.summary).toMatch(/^Recovered/);
    expect(s.measurements.failed).toBe(6);                            // the failures are still reported
    expect(openRules(h)).not.toContain(c.rule);
    expect(resolvedRules()).toContain(c.rule);
  });

  it('does not claim recovery when the last operation failed and nothing has run since', async () => {
    record(c.channel, 0, 4);
    now += (outcomes.OUTCOME_WINDOW_MINUTES + 1) * MIN;
    expect((await signalOf(c.signal)).state).toBe('UNVERIFIED');
  });
});

describe('components with nothing to call report that as configuration, not health', () => {
  it('reads Anthropic without a key as NOT_CONFIGURED', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect((await signalOf('anthropic')).state).toBe('NOT_CONFIGURED');
  });

  it('reads a host with no ffmpeg as NOT_CONFIGURED for the media pipeline', async () => {
    process.env.FFMPEG_PATH = path.join(os.tmpdir(), 'no-such-ffmpeg-binary');
    expect((await signalOf('media')).state).toBe('NOT_CONFIGURED');
  });
});

// ── the application-services layer and HTTP hardening, from real responses ───

describe('Application Services read the exceptions that reached the error reporter', () => {
  it('fails, then recovers', async () => {
    for (let i = 0; i < 30; i += 1) traffic.recordApiResponse(200, now);
    expect((await signalOf('services')).state).toBe('HEALTHY');

    for (let i = 0; i < 6; i += 1) { traffic.recordApiResponse(500, now); traffic.recordUnhandledError(500, now); }
    let h = await health.infrastructureHealth();
    expect(h.signals.find((s: Sig) => s.key === 'services').state).toBe('WARNING');
    expect(h.incidents.find((i: Inc) => i.ruleId === 'service-errors')).toMatchObject({ componentId: 'backend-services' });

    now += (traffic.API_WINDOW_MINUTES + 1) * MIN;
    traffic.recordApiResponse(200, now);
    h = await health.infrastructureHealth();
    expect(h.signals.find((s: Sig) => s.key === 'services').state).toBe('HEALTHY');
    expect(resolvedRules()).toContain('service-errors');
  });

  it('is fed by the platform\'s own error reporter', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { errorReporter } = require('../src/middleware/request-id.middleware');
    const req = { method: 'GET', originalUrl: '/api/v1/x', headers: {}, ip: '127.0.0.1' };
    errorReporter(Object.assign(new Error('boom'), { statusCode: 500 }), req, {}, () => undefined);
    errorReporter(Object.assign(new Error('nope'), { statusCode: 404 }), req, {}, () => undefined);
    expect(traffic.apiTraffic(now).unhandledErrors).toBe(1);
  });
});

describe('HTTP Hardening reads the headers on the responses that actually left', () => {
  it('is UNVERIFIED with no traffic, WARNING when a response leaves bare, HEALTHY once they all carry them', async () => {
    expect((await signalOf('httpHardening')).state).toBe('UNVERIFIED');

    traffic.recordApiResponse(200, now, true);
    traffic.recordApiResponse(200, now, false);
    const h = await health.infrastructureHealth();
    expect(h.signals.find((s: Sig) => s.key === 'httpHardening').state).toBe('WARNING');
    expect(openRules(h)).toContain('http-hardening-missing');

    now += (traffic.API_WINDOW_MINUTES + 1) * MIN;
    traffic.recordApiResponse(200, now, true);
    expect((await signalOf('httpHardening')).state).toBe('HEALTHY');
  });

  it('checks the header on the real response object', () => {
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      getHeader: (n: string) => (n === 'x-content-type-options' ? undefined : undefined),
    });
    traffic.apiTrafficMeter({}, res, () => undefined);
    res.emit('finish');
    expect(traffic.apiTraffic(Date.now()).unhardened).toBe(1);
  });
});

// ── rate limiting: the store the limiter really resolved ─────────────────────

describe('Rate Limiting reads the store it resolved and whether it can use it', () => {
  it('is HEALTHY on its memory store when no Redis is configured', async () => {
    expect((await signalOf('rateLimit')).state).toBe('HEALTHY');
  });

  it('is WARNING when Redis is configured but the limiter could not use it', async () => {
    redis.configured = true;
    const h = await health.infrastructureHealth();
    expect(h.signals.find((s: Sig) => s.key === 'rateLimit').state).toBe('WARNING');
    expect(openRules(h)).toContain('rate-limit-degraded');
  });

  it('degrades while Redis is down, and recovers when it answers', async () => {
    limiter.store = 'redis'; redis.configured = true; redis.healthy = false;
    expect(openRules(await health.infrastructureHealth())).toContain('rate-limit-degraded');
    redis.healthy = true;
    const h = await health.infrastructureHealth();
    expect(h.signals.find((s: Sig) => s.key === 'rateLimit').state).toBe('HEALTHY');
    expect(resolvedRules()).toContain('rate-limit-degraded');
  });
});

// ── WebSockets: the servers that were actually mounted ───────────────────────

describe('WebSocket Channels read the servers this process mounted', () => {
  const fakeServer = () => Object.assign(new EventEmitter(), { clients: new Set([1, 2]) });

  it('is NOT_CONFIGURED when nothing was mounted', async () => {
    expect((await signalOf('websockets')).state).toBe('NOT_CONFIGURED');
  });

  it('is HEALTHY when mounted, goes CRITICAL on socket errors, and recovers', async () => {
    const wss = fakeServer();
    wsRegistry.registerWebSocketServer('match', wss);
    const socket = new EventEmitter();
    wss.emit('connection', socket);
    let s = await signalOf('websockets');
    expect(s.state).toBe('HEALTHY');
    expect(s.measurements.clients).toBe(2);

    for (let i = 0; i < 3; i += 1) socket.emit('error', new Error('reset'));
    const h = await health.infrastructureHealth();
    expect(h.signals.find((x: Sig) => x.key === 'websockets').state).toBe('CRITICAL');
    expect(openRules(h)).toContain('websocket-errors');

    now += (outcomes.OUTCOME_WINDOW_MINUTES + 1) * MIN;
    s = await signalOf('websockets');
    expect(s.state).toBe('HEALTHY');
  });
});

// ── the Historical Query API: the read it serves ─────────────────────────────

describe('the Historical Query API times the read it serves', () => {
  it('fails CRITICAL when the read throws, and recovers when it answers', async () => {
    expect((await signalOf('historyQuery')).state).toBe('HEALTHY');
    historyReadFails = true;
    const h = await health.infrastructureHealth();
    expect(h.signals.find((s: Sig) => s.key === 'historyQuery').state).toBe('CRITICAL');
    expect(openRules(h)).toContain('history-query-failing');
    historyReadFails = false;
    expect((await signalOf('historyQuery')).state).toBe('HEALTHY');
  });
});

// ── the files the static server serves ───────────────────────────────────────

describe('browser modules read the files the static server serves', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-assets-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(dir, 'app.js'), 'void 0;');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is HEALTHY when present, CRITICAL when a file is gone or empty, HEALTHY again when restored', () => {
    const web = health.SERVED_ASSETS.find((a: { key: string }) => a.key === 'webApp');
    expect(health.assetSignal(web, dir).state).toBe('HEALTHY');

    fs.unlinkSync(path.join(dir, 'app.js'));
    const broken = health.assetSignal(web, dir);
    expect(broken.state).toBe('CRITICAL');
    expect(broken.measurements.missing).toBe('app.js');
    expect(health.evaluate([broken]).map((i: Inc) => i.ruleId)).toContain('asset-web-app');

    fs.writeFileSync(path.join(dir, 'app.js'), '');
    expect(health.assetSignal(web, dir).state).toBe('CRITICAL');

    fs.writeFileSync(path.join(dir, 'app.js'), 'void 0;');
    const back = health.assetSignal(web, dir);
    expect(back.state).toBe('HEALTHY');
    health.evaluate([back]);
    expect(resolvedRules()).toContain('asset-web-app');
  });

  it('finds every served module in this repository', async () => {
    for (const key of ['webApp', 'systemModule', 'dataVaultModule', 'reactClient']) {
      expect(`${key}: ${(await signalOf(key)).state}`).toBe(`${key}: HEALTHY`);
    }
  });
});

// ── internationalisation: the files every declared locale needs ──────────────

describe('Internationalisation reads the files every declared locale needs', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { LOCALES, DEFAULT_LOCALE } = require('../src/i18n/locales');
  let dir: string;
  const file = (kind: string, tag: string) => path.join(dir, 'i18n', kind, `${tag}.json`);
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-i18n-'));
    for (const kind of ['locales', 'catalogue']) {
      fs.mkdirSync(path.join(dir, 'i18n', kind), { recursive: true });
      for (const l of LOCALES) fs.writeFileSync(file(kind, l.tag), '{"a":"b"}');
    }
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is WARNING for a broken locale, CRITICAL for a broken base locale, HEALTHY when repaired', () => {
    expect(health.i18nSignal(dir).state).toBe('HEALTHY');
    const other = LOCALES.find((l: { tag: string }) => l.tag !== DEFAULT_LOCALE).tag;

    fs.unlinkSync(file('catalogue', other));
    const warn = health.i18nSignal(dir);
    expect(warn.state).toBe('WARNING');
    expect(health.evaluate([warn]).map((i: Inc) => i.ruleId)).toContain('i18n-locale-broken');

    fs.writeFileSync(file('locales', DEFAULT_LOCALE), '{ not json');
    expect(health.i18nSignal(dir).state).toBe('CRITICAL');

    fs.writeFileSync(file('catalogue', other), '{}');
    fs.writeFileSync(file('locales', DEFAULT_LOCALE), '{}');
    expect(health.i18nSignal(dir).state).toBe('HEALTHY');
  });

  it('finds every declared locale complete in this repository', async () => {
    expect((await signalOf('i18n')).state).toBe('HEALTHY');
  });
});

// ── coverage, and what is honestly left ──────────────────────────────────────

describe('instrumentation coverage', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

  /** The components with no production signal yet, and why. Changing this list is a decision. */
  const NOT_INSTRUMENTED: Record<string, string> = {
    'workflow-ci': 'CI results live in GitHub Actions; the server has no channel to read them.',
    'workflow-deploy': 'Same: a workflow run is not readable from the running server.',
    'workflow-backup': 'Same: the backup workflow\'s runs live in GitHub Actions; each backup it triggers leaves a BackupRecord.',
    'test-suite': 'Tests run in CI, not in production.',
    'boot-probe': 'Runs in CI against a fresh boot, not in production.',
    'i18n-check': 'Runs in CI; its runtime counterpart is the Internationalisation signal.',
    configuration: 'Read once at boot; a missing required value stops the process, so "running" would be a tautology, not a measurement.',
  };

  it('joins every other component to a live signal the health layer emits', async () => {
    const keys = new Set((await health.infrastructureSignals()).map((s: Sig) => s.key));
    const uninstrumented = manifest.components
      .filter((c: { id: string; healthKey: string | null }) => !c.healthKey || c.healthKey === 'ci' || c.healthKey === 'tests')
      .map((c: { id: string }) => c.id).sort();
    expect(uninstrumented).toEqual(Object.keys(NOT_INSTRUMENTED).sort());
    const dangling = manifest.components
      .filter((c: { healthKey: string | null }) => c.healthKey && !keys.has(c.healthKey))
      .map((c: { id: string }) => c.id);
    expect(dangling).toEqual([]);
  });

  it('never gives a planned plot a signal', () => {
    for (const f of manifest.future) expect(f.healthKey).toBeUndefined();
    const ids = new Set(manifest.components.map((c: { id: string }) => c.id));
    for (const f of manifest.future) expect(ids.has(f.id)).toBe(false);
  });

  it('gives every component rule a real component, district and catalogue entry', () => {
    const en = JSON.parse(read('public/infrastructure-city/i18n/en.json'));
    const ar = JSON.parse(read('public/infrastructure-city/i18n/ar.json'));
    const ids = new Set(manifest.components.map((c: { id: string }) => c.id));
    for (const { rule } of health.SIGNAL_RULES) {
      const r = health.ruleById(rule);
      expect(r).toBeTruthy();
      expect(ids.has(r.componentId)).toBe(true);
      expect(en[r.title]).toBeDefined();
      expect(ar[r.title]).toMatch(/[؀-ۿ]/);
    }
  });

  it('stays HEALTHY overall while every new signal is idle or unconfigured', async () => {
    const h = await health.infrastructureHealth();
    expect(h.incidents.filter((i: Inc) => i.severity !== 'INFO')).toEqual([]);
    expect(h.overall).toBe('HEALTHY');
  });
});

describe('each call site records the outcome of the operation it performs', () => {
  it.each([
    ['src/fabric/event-bus.ts', "recordOutcome('outbox', outcome !== 'FAILED')"],
    ['src/middleware/auth.middleware.ts', "recordOutcome('auth', true)"],
    ['src/middleware/auth.middleware.ts', "recordOutcome('auth', false)"],
    ['src/middleware/tenant-guard.middleware.ts', "recordOutcome('rbac', false)"],
    ['src/security/audit-chain.service.ts', "countOutcome('auditChain'"],
    ['src/services/ai.service.ts', "recordOutcome('anthropic', false)"],
    ['src/services/ai-llm.adapter.ts', "recordOutcome('anthropic', false)"],
    ['src/services/llm-adapter.service.ts', "recordOutcome('anthropic', false)"],
    ['src/services/video-hls.service.ts', "countOutcome('media'"],
    ['src/routes/data-pulse.routes.ts', "recordOutcome('sse', false)"],
    ['src/observability/metrics.service.ts', "recordOutcome('metrics', false)"],
    ['src/monitoring/monitoring.service.ts', "countOutcome('monitoring'"],
    ['src/utils/logger.ts', "recordOutcome('logging', false)"],
    ['src/realtime/match-ws.ts', "registerWebSocketServer('match', wss)"],
    ['src/realtime/market-ws.ts', "registerWebSocketServer('market', wss)"],
  ])('%s', (file, hook) => {
    expect(read(file)).toContain(hook);
  });

  it('counts a refused credential as the middleware working, not as a failure', () => {
    const src = read('src/middleware/auth.middleware.ts');
    expect(src).toContain("if (!(typeof status === 'number' && status < 500)) recordOutcome('auth', false);");
  });

  it('never changes what the counted operation returns or throws', async () => {
    await expect(outcomes.countOutcome('probe', Promise.resolve(7))).resolves.toBe(7);
    await expect(outcomes.countOutcome('probe', Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(outcomes.outcomeReading('probe')).toMatchObject({ ok: 1, failed: 1 });
  });
});
