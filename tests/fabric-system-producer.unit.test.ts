/**
 * tests/fabric-system-producer.unit.test.ts
 *
 * The System and Platform domain as a Data Fabric producer.
 *
 * TWO THINGS THIS SUITE EXISTS TO PROVE
 *
 * ONE — THE FABRIC CAN REPORT ON ITSELF WITHOUT EATING ITS OWN TAIL. This
 * producer publishes "the publisher is failing" through the publisher that is
 * failing. The test drives a transport that fails EVERY append and asserts the
 * process publishes exactly one event and then stops — not fewer, which would
 * mean the outage is invisible, and not more, which would mean a cascade.
 *
 * TWO — NOTHING IS INVENTED. There is no CPU figure, no memory figure, no
 * request rate and no uptime here, because this platform measures none of them.
 * The sharpest case is DEPLOYMENT: `deploy.yml` exits successfully without
 * POSTing its hook whenever `RENDER_DEPLOY_HOOK_URL` is unset, which it is, so
 * a green workflow is evidence that a workflow ran and of nothing else.
 * `system.deploy.completed` is registered and produced by nothing, and a test
 * pins that rather than leaving it to a comment.
 *
 * AND THE USUAL — no environment value, key, connection string, token or stack
 * trace reaches any representation. A configuration event names the setting
 * that moved and never what it moved to.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const ADMIN = 'u-admin';

/** Everything the platform holds that must never leave it. */
const SECRETS = {
  databaseUrl: 'postgresql://familista:Pa55w0rd-real@ep-cool-fog-123456.eu-central-1.aws.neon.tech/familista?sslmode=require',
  redisUrl: 'rediss://default:AX9pAAIjcDE4@eu2-clean-marmot-31337.upstash.io:31337',
  anthropicKey: 'sk-ant-api03-DEADBEEFcafef00d1234567890abcdefDEADBEEFcafef00d',
  jwtSecret: 'f7d3b1a9c5e2408f6a1c3e5d7b9f0a2c4e6d8b0f2a4c6e8d0b2f4a6c8e0d2b4f',
  deployHook: 'https://api.render.com/deploy/srv-d1abcdef23456789?key=Xq9_TOPSECRET',
  smtpPassword: 'SG.9f3a2b1c8d.aVeryRealSendgridApiKeyValue',
  sessionCookie: 'familista_sid=s%3AeyJ1IjoiYWRtaW4ifQ.9f3a2b1c8d',
  stackTrace: 'Error: connect ETIMEDOUT\n    at Socket.<anonymous> (/app/node_modules/pg/lib/client.js:132:17)\n    with password Pa55w0rd-real',
  flagDescription: 'Turns on the U15 medical dashboard for Hertha only — do not announce',
};

const state = { health: [] as Row[], flags: [] as Row[], audit: [] as Row[] };

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('gte' in v) return new Date(row[k]).getTime() >= new Date((v as Row).gte).getTime();
    }
    if (v === null) return row[k] == null;
    return row[k] === v;
  });

const copy = <T>(row: T): T => (row == null ? row : JSON.parse(JSON.stringify(row)) as T);

const db: Row = {
  productionHealthCheck: {
    findFirst: async ({ where = {} }: Row = {}) => {
      const hits = state.health.filter((r) => match(r, where));
      return copy(hits[hits.length - 1] ?? null);
    },
    findMany: async ({ where = {} }: Row = {}) => copy(state.health.filter((r) => match(r, where))),
    create: async ({ data }: Row) => {
      const row = { id: `h-${state.health.length + 1}`, capturedAt: new Date().toISOString(), ...data };
      state.health.push(row); return copy(row);
    },
  },
  featureFlag: {
    findUnique: async ({ where }: Row) => copy(state.flags.find((f) => f.key === where.key) ?? null),
    findMany: async () => copy(state.flags),
    upsert: async ({ where, create, update }: Row) => {
      const existing = state.flags.find((f) => f.key === where.key);
      if (existing) { Object.assign(existing, update); return copy(existing); }
      const row = { id: `f-${state.flags.length + 1}`, ...create };
      state.flags.push(row); return copy(row);
    },
    delete: async ({ where }: Row) => {
      const i = state.flags.findIndex((f) => f.key === where.key);
      return i >= 0 ? copy(state.flags.splice(i, 1)[0]) : null;
    },
  },
  platformAuditEvent: { create: async ({ data }: Row) => { state.audit.push(data); return data; } },
  auditEvent: { create: async ({ data }: Row) => data },
  eventOutbox: { create: async ({ data }: Row) => data, findMany: async () => [] },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
// Every source the platform registers at boot, so a lane assertion below
// describes the real board rather than whichever producers this file
// happened to import.
import '../src/fabric/producers/coach-market.producer';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { project, sourceLaneFor } from '../src/fabric/pulse/pulse.service';
import { resolveSubjects } from '../src/fabric/pulse/subject-resolver.service';
import { fabricEvent, fabricEventsForSource } from '../src/fabric/registry/event-registry';
import { visibleFabricSources, sourceLanes } from '../src/fabric/registry/source-registry';
import { validateEventPayload } from '../src/fabric/registry/schema-registry';
import { resetRegistryHealth } from '../src/fabric/registry/unknown-events';
import { publishFabricEvent } from '../src/fabric/registry/publisher';
import {
  publishSystemServiceStarted, publishSystemServiceStopped,
  publishSystemHealthChanged, publishSystemConfigChanged, publishSystemFeatureToggled,
  noteFabricPublishOutcome, noteFabricRegistryProblem,
  fabricSelfHealth, resetFabricSelfHealth,
} from '../src/fabric/producers/system.producer';

import * as monitoring from '../src/monitoring/monitoring.service';
import * as flags from '../src/services/admin-feature-flag.service';

let published: FamilistaEvent[] = [];

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const transport: EventTransport = {
  name: 'RECORDING',
  async append(event: FamilistaEvent) { published.push(event); return 'STORED'; },
  async read() { return []; },
} as EventTransport;

const ACTOR = { adminId: 'a-1', userId: ADMIN, ipAddress: null, userAgent: null };

beforeEach(() => {
  published = [];
  setEventTransport(transport);
  resetFabricSelfHealth();
  resetRegistryHealth();
  state.health = [];
  state.flags = [];
  state.audit = [];
});

afterEach(async () => { await settle(); });
afterAll(async () => { await settle(); setEventTransport(null); });

const types = () => published.map((e) => e.eventType).sort();
const one = (type: string) => {
  const hits = published.filter((e) => e.eventType === type);
  expect(`${type} count: ${hits.length}`).toBe(`${type} count: 1`);
  return hits[0];
};

// ══════════════════════════════════════════════════════════════════════════════
// 1 · THE RECURSION PROBLEM
// ══════════════════════════════════════════════════════════════════════════════

describe('the fabric reporting on itself', () => {
  it('a transport that fails EVERY append produces exactly one event, then stops', async () => {
    let attempts = 0;
    setEventTransport({
      name: 'ALWAYS_BROKEN',
      async append(event: FamilistaEvent) {
        attempts += 1;
        published.push(event);          // record what it TRIED to write
        throw new Error('outbox is down');
      },
      async read() { return []; },
    } as EventTransport);

    await publishFabricEvent({ eventType: 'club.created', clubId: 'c-1' });
    await settle();

    // One business event attempted, one degraded event attempted, and nothing
    // more — the degraded event's own failure is NOT reported, which is the
    // guard that makes a cascade impossible rather than merely unlikely.
    expect(published.filter((e) => e.eventType === 'system.fabric.publisher.degraded'))
      .toHaveLength(1);
    expect(attempts).toBe(2);
    expect(fabricSelfHealth().publisherDegraded).toBe(true);
    setEventTransport(transport);
  });

  it('a thousand failures are one event — degraded is a state, not a tally', async () => {
    for (let i = 0; i < 1000; i += 1) noteFabricPublishOutcome('club.created', false);
    await settle();
    expect(types()).toEqual(['system.fabric.publisher.degraded']);
  });

  it('recovery is announced once, and only after a real outage', async () => {
    // Healthy successes announce nothing at all.
    for (let i = 0; i < 50; i += 1) noteFabricPublishOutcome('club.created', true);
    await settle();
    expect(types()).toEqual([]);

    noteFabricPublishOutcome('club.created', false);
    await settle();
    published = [];

    noteFabricPublishOutcome('club.created', true);
    noteFabricPublishOutcome('club.created', true);
    noteFabricPublishOutcome('club.created', true);
    await settle();
    expect(types()).toEqual(['system.fabric.publisher.recovered']);
    expect(fabricSelfHealth().publisherDegraded).toBe(false);
  });

  it('a failure to publish a self-health event is never itself reported', async () => {
    noteFabricPublishOutcome('system.fabric.publisher.degraded', false);
    noteFabricPublishOutcome('system.fabric.publisher.recovered', false);
    noteFabricPublishOutcome('system.fabric.registry.degraded', false);
    await settle();

    expect(types()).toEqual([]);
    expect(fabricSelfHealth().publisherDegraded).toBe(false);
  });

  it('the registry reports a problem once, whatever arrives afterwards', async () => {
    noteFabricRegistryProblem('UNREGISTERED_TYPE', 'finance.invoice.shredded');
    for (let i = 0; i < 100; i += 1) {
      noteFabricRegistryProblem('SCHEMA_FAILURE', `some.other.name${i}`);
    }
    await settle();

    expect(types()).toEqual(['system.fabric.registry.degraded']);
    expect(one('system.fabric.registry.degraded').payload).toEqual({
      problem: 'UNREGISTERED_TYPE', eventType: 'finance.invoice.shredded',
      component: 'FABRIC', environment: 'test',
    });
  });

  it('a self-health name never reaches the registry reporter either', async () => {
    noteFabricRegistryProblem('UNREGISTERED_TYPE', 'system.fabric.registry.degraded');
    await settle();
    expect(types()).toEqual([]);
    expect(fabricSelfHealth().registryDegraded).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2 · HEALTH — TRANSITIONS, NOT POLLS
// ══════════════════════════════════════════════════════════════════════════════

describe('service health', () => {
  const record = (state_: string, latencyMs?: number) =>
    monitoring.recordHealth({ service: 'database', state: state_ as never, latencyMs } as never);

  it('the first report of a service publishes one transition', async () => {
    await record('HEALTHY', 12);
    await settle();

    expect(types()).toEqual(['system.health.changed']);
    expect(one('system.health.changed').payload).toEqual({
      service: 'database', from: null, to: 'HEALTHY',
      latencyMs: 12, component: 'API', environment: 'test',
    });
    expect(state.health).toHaveLength(1);
  });

  it('polling an unchanged service publishes NOTHING, however often', async () => {
    await record('HEALTHY');
    await settle();
    published = [];

    for (let i = 0; i < 20; i += 1) await record('HEALTHY');
    await settle();

    expect(types()).toEqual([]);
    // and every poll is still RECORDED — the rows are the log, the events are
    // the news, and this change does not touch the log.
    expect(state.health).toHaveLength(21);
  });

  it('publishes each real transition, in both directions', async () => {
    await record('HEALTHY');
    await record('HEALTHY');
    await record('DEGRADED');
    await record('DEGRADED');
    await record('HEALTHY');
    await settle();

    const moves = published
      .filter((e) => e.eventType === 'system.health.changed')
      .map((e) => `${(e.payload as Row).from} → ${(e.payload as Row).to}`);
    expect(moves).toEqual(['null → HEALTHY', 'HEALTHY → DEGRADED', 'DEGRADED → HEALTHY']);
  });

  it('two services are tracked apart', async () => {
    await monitoring.recordHealth({ service: 'database', state: 'HEALTHY' } as never);
    await monitoring.recordHealth({ service: 'redis', state: 'HEALTHY' } as never);
    await settle();
    expect(published.map((e) => (e.payload as Row).service).sort()).toEqual(['database', 'redis']);
  });

  it('never carries the check’s payload, which is where a secret would arrive', async () => {
    await monitoring.recordHealth({
      service: 'database', state: 'DEGRADED', latencyMs: 4200,
      payload: { url: SECRETS.databaseUrl, trace: SECRETS.stackTrace } as never,
    } as never);
    await settle();

    const wire = JSON.stringify(published);
    expect(wire).not.toContain(SECRETS.databaseUrl);
    expect(wire).not.toContain(SECRETS.stackTrace);
    expect(wire).not.toContain('Pa55w0rd');
    // the row still holds it, because the module still needs it
    expect(JSON.stringify(state.health)).toContain('Pa55w0rd');
  });

  it('a rejected health report publishes nothing', async () => {
    await expect(monitoring.recordHealth({ service: '', state: 'HEALTHY' } as never)).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3 · CONFIGURATION AND FEATURES
// ══════════════════════════════════════════════════════════════════════════════

describe('feature flags', () => {
  const upsert = (over: Row = {}) => flags.upsertFeatureFlag(ACTOR as never, {
    key: 'ACADEMY_MEDICAL_V2', name: 'Academy medical v2',
    description: SECRETS.flagDescription, defaultEnabled: false,
    enabledForPlans: ['ELITE'], isInternal: true, ...over,
  } as never);

  it('creating a flag that is off is a configuration change', async () => {
    await upsert();
    await settle();

    expect(types()).toEqual(['system.config.changed']);
    expect(one('system.config.changed').payload).toEqual({
      setting: 'ACADEMY_MEDICAL_V2', component: 'CONFIG', environment: 'test',
    });
  });

  it('turning one on and off publishes the transition each way, once', async () => {
    await upsert();
    await settle();
    published = [];

    await upsert({ defaultEnabled: true });
    await settle();
    expect(types()).toEqual(['system.feature.enabled']);
    published = [];

    await upsert({ defaultEnabled: true });     // resent, unchanged
    await settle();
    expect(types()).toEqual(['system.config.changed']);
    published = [];

    await upsert({ defaultEnabled: false });
    await settle();
    expect(types()).toEqual(['system.feature.disabled']);
  });

  it('deleting an enabled flag is a disablement', async () => {
    await upsert({ defaultEnabled: true });
    await settle();
    published = [];

    await flags.deleteFeatureFlag(ACTOR as never, 'ACADEMY_MEDICAL_V2');
    await settle();
    expect(types()).toEqual(['system.feature.disabled']);
    expect(state.flags).toHaveLength(0);
  });

  it('deleting a flag that is not there publishes nothing', async () => {
    await expect(flags.deleteFeatureFlag(ACTOR as never, 'NOPE')).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });

  it('names the setting and never its description, plans or value', async () => {
    await upsert({ defaultEnabled: true });
    await settle();

    const wire = JSON.stringify(published);
    expect(wire).not.toContain(SECRETS.flagDescription);
    expect(wire).not.toContain('ELITE');
    expect(wire).not.toContain('Academy medical v2');
    expect(Object.keys(one('system.feature.enabled').payload as Row).sort())
      .toEqual(['component', 'environment', 'setting']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4 · SERVICES
// ══════════════════════════════════════════════════════════════════════════════

describe('platform services', () => {
  it('starting and stopping a worker publishes one event each', async () => {
    publishSystemServiceStarted('ai-agent-worker');
    publishSystemServiceStopped('ai-agent-worker');
    await settle();

    expect(types()).toEqual(['system.service.started', 'system.service.stopped']);
    expect(one('system.service.started').payload).toEqual({
      service: 'ai-agent-worker', component: 'WORKER', environment: 'test',
    });
    expect(one('system.service.started').subjectType).toBe('PLATFORM');
  });

  it('the three workers publish behind their own idempotence guards', () => {
    // Each `start*` returns early when already running, so the publish inside
    // it fires once per real transition rather than once per call.
    for (const file of ['ai-agent.worker.ts', 'video-transcode.worker.ts', 'automation.worker.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', file), 'utf8');
      const start = src.slice(src.indexOf('export function start'));
      expect(`${file} guards: ${/if \(_running\) return;/.test(start)}`).toBe(`${file} guards: true`);
      expect(`${file} publishes: ${/publishSystemServiceStarted\(/.test(start)}`).toBe(`${file} publishes: true`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5 · DEPLOYMENT — THE THING THAT MUST NOT BE CLAIMED
// ══════════════════════════════════════════════════════════════════════════════

describe('deployment telemetry', () => {
  it('is registered and produced by NOTHING, because nothing observes a deployment', () => {
    for (const type of ['system.deploy.started', 'system.deploy.completed', 'system.deploy.failed']) {
      const spec = fabricEvent(type);
      expect(`${type} registered: ${!!spec}`).toBe(`${type} registered: true`);
      expect(`${type} produced: ${spec!.produced}`).toBe(`${type} produced: false`);
    }
  });

  it('no code in the platform publishes a deploy event', () => {
    const root = path.join(__dirname, '..', 'src');
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name))
        : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []));
    for (const file of walk(root)) {
      const src = fs.readFileSync(file, 'utf8');
      // The producer REGISTERS the names; nothing may publish one.
      if (file.endsWith('system.producer.ts')) continue;
      expect(`${path.relative(root, file)} publishes a deploy event: ${/publish\w*\(\s*['"]system\.deploy/.test(src)}`)
        .toBe(`${path.relative(root, file)} publishes a deploy event: false`);
    }
  });

  it('the deploy workflow exits successfully without deploying, which is why', () => {
    const wf = fs.readFileSync(
      path.join(__dirname, '..', '.github', 'workflows', 'deploy.yml'), 'utf8',
    );
    // The condition this platform actually has: no hook, no POST, green tick.
    expect(wf).toContain('RENDER_DEPLOY_HOOK_URL');
    expect(wf).toMatch(/if \[ -z "\$RENDER_DEPLOY_HOOK_URL" \]/);
    expect(wf).toContain('exit 0');
  });

  it('never carries a deploy hook, even in the shape it would take', () => {
    expect(validateEventPayload('system.deploy.started', 1, {
      revision: 'abc1234', failureCategory: null, component: 'DEPLOY',
      environment: 'production', hookUrl: SECRETS.deployHook,
    }).ok).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6 · NO SECRET REACHES OBSERVABILITY
// ══════════════════════════════════════════════════════════════════════════════

describe('redaction', () => {
  const everywhere = async () => {
    const frames = published.map((e) => project(e, 'STORED'));
    await resolveSubjects(frames);
    const catalogue = fabricEventsForSource('system');
    return JSON.stringify({ published, frames, catalogue });
  };

  it('no environment value, key, connection string, cookie or stack trace survives', async () => {
    await monitoring.recordHealth({
      service: 'database', state: 'DEGRADED',
      payload: { url: SECRETS.databaseUrl, trace: SECRETS.stackTrace } as never,
    } as never);
    await flags.upsertFeatureFlag(ACTOR as never, {
      key: 'ACADEMY_MEDICAL_V2', name: 'Academy medical v2',
      description: SECRETS.flagDescription, defaultEnabled: true, enabledForPlans: [], isInternal: false,
    } as never);
    publishSystemServiceStarted('ai-agent-worker');
    noteFabricPublishOutcome('club.created', false);
    noteFabricRegistryProblem('SCHEMA_FAILURE', 'finance.invoice.issued');
    await settle();

    const blob = await everywhere();
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(`${name}: ${blob.includes(secret)}`).toBe(`${name}: false`);
    }
    // and the distinctive fragments of each, in case one was truncated
    for (const fragment of ['Pa55w0rd', 'sk-ant-api03', 'neon.tech', 'upstash.io',
      'api.render.com/deploy', 'SG.9f3a2b1c8d', 'familista_sid', 'node_modules/pg']) {
      expect(`${fragment}: ${blob.includes(fragment)}`).toBe(`${fragment}: false`);
    }
  });

  it('the producer reads the environment’s NAME and never its values', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'fabric', 'producers', 'system.producer.ts'), 'utf8',
    );
    const reads = [...src.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]);
    // Exactly one, and it is the deployment's name.
    expect(reads).toEqual(['NODE_ENV']);
  });

  it('a frame carries no payload — a component id is all a board gets', async () => {
    publishSystemServiceStarted('ai-agent-worker');
    await settle();

    const frames = published.map((e) => project(e, 'STORED'));
    await resolveSubjects(frames);
    const frame = frames[0] as Row;
    expect(frame.payload).toBeUndefined();
    expect(frame.metadata).toBeUndefined();
    expect(frame.subjectId).toBe('ai-agent-worker');
    expect(frame.subjectType).toBe('PLATFORM');
    expect(frame.subjectLabel).toBeNull();
    expect(frame.source).toBe('System');
  });

  it('every System payload validates against its strict schema', async () => {
    publishSystemServiceStarted('w');
    publishSystemServiceStopped('w');
    publishSystemHealthChanged('database', 'HEALTHY', 'DEGRADED', 4200);
    publishSystemConfigChanged('SOME_FLAG', ADMIN);
    publishSystemFeatureToggled('SOME_FLAG', true, ADMIN);
    publishSystemFeatureToggled('SOME_FLAG', false, ADMIN);
    noteFabricPublishOutcome('club.created', false);
    noteFabricRegistryProblem('UNREGISTERED_TYPE', 'a.b');
    await settle();

    // Nine, not eight: degrading the publisher and then appending successfully
    // through the real bus announces the recovery, which is the whole loop
    // working rather than a stray event.
    expect(published).toHaveLength(9);
    expect(published.filter((e) => e.eventType === 'system.fabric.publisher.recovered'))
      .toHaveLength(1);
    for (const e of published) {
      const check = validateEventPayload(e.eventType, 1, e.payload);
      expect(`${e.eventType}: ${check.ok ? 'ok' : JSON.stringify((check as Row).issues)}`)
        .toBe(`${e.eventType}: ok`);
    }
  });

  it('a strict schema refuses a config VALUE, a URL or a trace added later', () => {
    expect(validateEventPayload('system.config.changed', 1, {
      setting: 'DATABASE_URL', component: 'CONFIG', environment: 'test',
      value: SECRETS.databaseUrl,
    }).ok).toBe(false);
    expect(validateEventPayload('system.health.changed', 1, {
      service: 'database', from: 'HEALTHY', to: 'DEGRADED', latencyMs: 1,
      component: 'API', environment: 'test', trace: SECRETS.stackTrace,
    }).ok).toBe(false);
    expect(validateEventPayload('system.route.changed', 1, {
      surface: 'squad', component: 'API', environment: 'test',
      url: '/squad?token=abc123',
    }).ok).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7 · THE CATALOGUE
// ══════════════════════════════════════════════════════════════════════════════

describe('the catalogue', () => {
  const PRODUCED = [
    'system.service.started', 'system.service.stopped',
    'system.health.changed',
    'system.config.changed', 'system.feature.enabled', 'system.feature.disabled',
    'system.fabric.publisher.degraded', 'system.fabric.publisher.recovered',
    'system.fabric.registry.degraded',
  ];

  it('registers every produced type under the system source, about a PLATFORM', () => {
    for (const type of PRODUCED) {
      const spec = fabricEvent(type);
      expect(`${type} registered: ${!!spec}`).toBe(`${type} registered: true`);
      expect(`${type} source: ${spec!.source}`).toBe(`${type} source: system`);
      expect(`${type} entity: ${spec!.entityType}`).toBe(`${type} entity: PLATFORM`);
      expect(`${type} produced: ${spec!.produced}`).toBe(`${type} produced: true`);
      expect(sourceLaneFor(type)).toBe('System');
      expect(validateEventPayload(type, 1, null).ok).toBe(false);
    }
  });

  it('says plainly which names are declared and not yet published', () => {
    const declared = fabricEventsForSource('system')
      .filter((s) => !s.produced && s.type.startsWith('system.'))
      .map((s) => s.type).sort();
    expect(declared).toEqual([
      'system.deploy.completed', 'system.deploy.failed', 'system.deploy.started',
      'system.fabric.registry.recovered',
      'system.integration.connected', 'system.integration.disconnected',
      'system.job.completed', 'system.job.failed', 'system.job.started',
      'system.module.opened', 'system.page.viewed', 'system.route.changed',
    ]);
  });

  it('and everything else under the system prefix IS published by this build', () => {
    const produced = fabricEventsForSource('system')
      .filter((s) => s.produced && s.type.startsWith('system.'))
      .map((s) => s.type).sort();
    expect(produced).toEqual([...PRODUCED].sort());
  });

  it('adds no source card for any platform component', () => {
    const ids = visibleFabricSources().map((s) => s.id);
    for (const invented of ['api', 'database', 'redis', 'cache', 'auth', 'authentication',
      'deployments', 'jobs', 'integrations', 'storage', 'email']) {
      expect(`${invented} is a source: ${ids.includes(invented)}`).toBe(`${invented} is a source: false`);
    }
    expect(ids).toContain('system');
    expect(sourceLanes()).toEqual([
      'Clubs', 'Users', 'Players', 'Training', 'Matches',
      'Transfers', 'Coach Market', 'Medical', 'Media', 'AI', 'System',
    ]);
  });

  it('invents no metric the platform does not measure', () => {
    for (const spec of fabricEventsForSource('system')) {
      expect(`${spec.type}: ${/cpu|memory|uptime|throughput|queue.?depth|error.?rate/i.test(spec.type)}`)
        .toBe(`${spec.type}: false`);
    }
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'fabric', 'producers', 'system.producer.ts'), 'utf8',
    );
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/cpuPercent|memoryMb|heapUsed|uptimeSec|requestsPerMin|errorRate/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8 · THE FABRIC MUST NOT BE ABLE TO BREAK A SYSTEM OPERATION
// ══════════════════════════════════════════════════════════════════════════════

describe('when the fabric is broken', () => {
  it('a transport that throws does not fail the health write or the flag write', async () => {
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('outbox is down'); },
      async read() { return []; },
    } as EventTransport);

    const health = await monitoring.recordHealth({ service: 'database', state: 'HEALTHY' } as never);
    const flag = await flags.upsertFeatureFlag(ACTOR as never, {
      key: 'X', name: 'X', defaultEnabled: true, enabledForPlans: [], isInternal: false,
    } as never);
    await settle();

    expect(health.id).toBeTruthy();
    expect(flag.id).toBeTruthy();
    expect(state.health).toHaveLength(1);
    expect(state.flags).toHaveLength(1);
    setEventTransport(transport);
  });
});
