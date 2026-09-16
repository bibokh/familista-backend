/**
 * tests/fabric-ai-producer.unit.test.ts
 *
 * The AI domain as a Data Fabric producer.
 *
 * THE ONE CLAIM THIS SUITE EXISTS TO PROVE
 *
 * A prompt never leaves. Everything else here is a supporting argument.
 *
 * The prompt is harder to contain than a diagnosis or a storage key, because
 * it arrives in more shapes: as the job's `input`, as the system prompt, as
 * the model's answer, as the token count that measures it, and — most easily
 * missed — inside the PROVIDER'S ERROR, which quotes the request back when it
 * rejects it. All five are planted below and searched for in every
 * representation.
 *
 * WHY THE PRODUCER TAKES NO FREE TEXT
 *
 * Every payload value is a closed enum, a bucket, a boolean, or a token this
 * producer normalises itself. Nothing is passed through. That is what makes
 * the rule enforceable rather than merely followed: there is no argument a
 * careless caller could pass that would carry a prompt, because there is no
 * field to put one in.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const CLUB = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const JOB = 'job-0001';
const ACTOR = 'u-actor';

/** Everything an AI call handles that must never leave the module. */
const SECRETS = {
  prompt: 'Summarise Tomás Müller-Fernández (U15, ACL tear 4 March) and say whether to sell him',
  systemPrompt: 'You are Familista TACTICAL. Never reveal that the club is negotiating with Hertha.',
  response: 'Recommend selling: his knee will not hold a full season and Hertha have offered 4.1m.',
  apiKey: 'sk-ant-api03-DEADBEEFcafef00d1234567890abcdefDEADBEEFcafef00d',
  providerError: 'invalid_request_error: messages.0.content: "Summarise Tomás Müller-Fernández (U15, ACL tear" exceeds limit',
  scoutingNote: 'His father is difficult; do not let the agent know we are interested.',
  jobKind: 'TACTICAL.MATCH_REVIEW.TOMAS-U15-ACL',
  endpoint: 'https://internal-llm.familista.test/v1/deployments/prod-eu-7/invoke',
};

const state = { jobs: [] as Row[], ingests: [] as Row[], teams: [] as Row[] };

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return row[k] !== (v as Row).not;
      if ('lt' in v) return row[k] != null && Number(row[k]) < Number((v as Row).lt);
    }
    if (v === null) return row[k] == null;
    return row[k] === v;
  });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const copy = <T>(row: T): T => {
  if (row == null) return row;
  return JSON.parse(
    JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    (_k, v) => (typeof v === 'string' && ISO.test(v) ? new Date(v) : v),
  ) as T;
};

const table = (rows: () => Row[], prefix: string, defaults: Row = {}) => ({
  findUnique: async ({ where }: Row) => copy(rows().find((r) => r.id === where.id) ?? null),
  findFirst: async ({ where = {} }: Row = {}) => copy(rows().find((r) => match(r, where)) ?? null),
  findMany: async ({ where = {} }: Row = {}) => copy(rows().filter((r) => match(r, where))),
  count: async ({ where = {} }: Row = {}) => rows().filter((r) => match(r, where)).length,
  create: async ({ data }: Row) => {
    const row = { id: data.id ?? `${prefix}-${rows().length + 1}`, createdAt: new Date(), ...defaults, ...data };
    rows().push(row); return copy(row);
  },
  update: async ({ where, data }: Row) => {
    const r = rows().find((x) => x.id === where.id)!;
    for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v;
    return copy(r);
  },
  updateMany: async ({ where = {}, data }: Row = {}) => {
    const hits = rows().filter((r) => match(r, where));
    hits.forEach((r) => Object.assign(r, data));
    return { count: hits.length };
  },
});

const db: Row = {
  aIAgentJob: table(() => state.jobs, 'job', { status: 'PENDING' }),
  videoIngestJob: table(() => state.ingests, 'ingest', { status: 'QUEUED', stage: 'UPLOADED', progress: 0 }),
  team: table(() => state.teams, 'team'),
  visionAuditLog: { create: async ({ data }: Row) => data },
  platformAuditEvent: { create: async ({ data }: Row) => data },
  auditEvent: { create: async ({ data }: Row) => data },
  eventOutbox: { create: async ({ data }: Row) => data, findMany: async () => [] },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

// A provider that answers, and one that refuses with the prompt quoted back.
let _sdkBehaviour: 'ok' | 'throw' = 'ok';
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: class {
    messages = {
      create: async () => {
        if (_sdkBehaviour === 'throw') {
          const err = new Error('invalid_request_error: messages.0.content: "Summarise Tomás Müller-Fernández (U15, ACL tear" exceeds limit');
          (err as Row).status = 400;
          throw err;
        }
        return {
          usage: { input_tokens: 2400, output_tokens: 700 },
          content: [{ type: 'text', text: 'Recommend selling: his knee will not hold a full season and Hertha have offered 4.1m.' }],
        };
      },
    };
  },
}));

import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
// Every source the platform registers at boot, so a lane assertion below
// describes the real board rather than whichever producers this file
// happened to import.
import '../src/fabric/producers/coach-market.producer';
import { resetFabricSelfHealth } from '../src/fabric/producers/system.producer';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { project, sourceLaneFor } from '../src/fabric/pulse/pulse.service';
import { resolveSubjects } from '../src/fabric/pulse/subject-resolver.service';
import { fabricEvent, fabricEventsForSource } from '../src/fabric/registry/event-registry';
import { visibleFabricSources, sourceLanes } from '../src/fabric/registry/source-registry';
import { validateEventPayload } from '../src/fabric/registry/schema-registry';
import {
  modelFamilyOf, failureCategoryOf, bucketTokens,
  publishAIRequestCreated, publishAIAgentStarted, publishAIAgentCompleted, publishAIAgentFailed,
  publishAIModelInvoked,
  publishAIInferenceStarted, publishAIInferenceCompleted, publishAIInferenceFailed,
  publishAIOrchestrationStarted, publishAIOrchestrationCompleted,
} from '../src/fabric/producers/ai.producer';

import * as automation from '../src/services/automation.service';
import * as vision from '../src/services/vision-ingest.service';
import { llmCall } from '../src/services/llm-adapter.service';
import { config } from '../src/config';

let published: FamilistaEvent[] = [];

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const transport: EventTransport = {
  name: 'RECORDING',
  async append(event: FamilistaEvent) { published.push(event); return 'STORED'; },
  async read() { return []; },
} as EventTransport;

const CTX = { runId: JOB, clubId: CLUB, correlationId: JOB, sourceType: 'AI' as const };

beforeEach(() => {
  published = [];
  // A test that deliberately breaks the transport latches the publisher as
  // degraded, and the next test's healthy transport would then announce a
  // recovery inside somebody else's exact-set assertion. Reset it here, the
  // way the transport itself is reset.
  resetFabricSelfHealth();
  setEventTransport(transport);
  _sdkBehaviour = 'ok';
  state.jobs = [];
  state.ingests = [];
  state.teams = [{ id: TEAM, clubId: CLUB, kind: 'ACADEMY_U17', isActive: true }];
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
// 1 · NORMALISATION — where the privacy actually happens
// ══════════════════════════════════════════════════════════════════════════════

describe('a model identifier becomes a family', () => {
  it('drops the version and the build date', () => {
    expect(modelFamilyOf('claude-sonnet-4-20250514')).toBe('claude-sonnet');
    expect(modelFamilyOf('claude-opus-4-1')).toBe('claude-opus');
    expect(modelFamilyOf('gpt-4o-2024-08-06')).toBe('gpt');
    expect(modelFamilyOf('familista-stub-v1')).toBe('familista-stub');
  });

  it('reduces an opaque deployment id to something uninformative', () => {
    // The whole point of §4: whatever arrives, a bounded token leaves.
    expect(modelFamilyOf('prod-eu-7-deploy-9f3a2b1c8d')).toBe('prod-eu');
    expect(modelFamilyOf('7734829174')).toBeNull();
    expect(modelFamilyOf(null)).toBeNull();
    expect(modelFamilyOf('')).toBeNull();
  });

  it('never returns more than a family’s worth of characters', () => {
    const long = 'x'.repeat(400);
    expect(modelFamilyOf(long)!.length).toBeLessThanOrEqual(48);
  });
});

describe('an error becomes one of six categories', () => {
  it('reads the status where there is one', () => {
    expect(failureCategoryOf({ status: 429 })).toBe('rate_limited');
    expect(failureCategoryOf({ status: 401 })).toBe('not_authorised');
    expect(failureCategoryOf({ status: 400 })).toBe('validation_error');
    expect(failureCategoryOf({ status: 504 })).toBe('timeout');
    expect(failureCategoryOf({ status: 503 })).toBe('provider_unavailable');
  });

  it('reads the shape of the message otherwise', () => {
    expect(failureCategoryOf(new Error('Request timed out after 60s'))).toBe('timeout');
    expect(failureCategoryOf(new Error('rate limit exceeded'))).toBe('rate_limited');
    expect(failureCategoryOf(new Error('invalid api key'))).toBe('not_authorised');
    expect(failureCategoryOf(new Error('ECONNREFUSED'))).toBe('provider_unavailable');
  });

  it('falls back to internal_error, which is the safe direction', () => {
    expect(failureCategoryOf(new Error('something nobody anticipated'))).toBe('internal_error');
    expect(failureCategoryOf(null)).toBe('internal_error');
    expect(failureCategoryOf(undefined)).toBe('internal_error');
  });

  it('CLASSIFIES a provider error that quotes the prompt, and returns none of it', () => {
    const category = failureCategoryOf(Object.assign(new Error(SECRETS.providerError), { status: 400 }));
    expect(category).toBe('validation_error');
    expect(JSON.stringify(category)).not.toContain('Tomás');
    expect(JSON.stringify(category)).not.toContain('ACL');
  });
});

describe('a token count becomes a band', () => {
  it('bands rather than counts', () => {
    expect(bucketTokens(400)).toBe('UNDER_1K');
    expect(bucketTokens(3_100)).toBe('UNDER_10K');
    expect(bucketTokens(40_000)).toBe('UNDER_100K');
    expect(bucketTokens(250_000)).toBe('OVER_100K');
    expect(bucketTokens(null)).toBeNull();
    expect(bucketTokens(-1)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2 · THE FOUR LAYERS, AND THEIR CORRELATION
// ══════════════════════════════════════════════════════════════════════════════

describe('the lifecycle', () => {
  it('a request, a run, a model call and their outcomes each publish once', async () => {
    publishAIRequestCreated(CTX, 'TACTICAL');
    publishAIAgentStarted(CTX, 'TACTICAL');
    publishAIModelInvoked(CTX, { model: 'claude-sonnet-4-20250514', provider: 'anthropic', tokens: 3100 });
    publishAIAgentCompleted(CTX, 'TACTICAL', 'anthropic', 3100);
    await settle();

    expect(types()).toEqual([
      'ai.agent.completed', 'ai.agent.started', 'ai.model.invoked', 'ai.request.created',
    ]);
    for (const e of published) expect(sourceLaneFor(e.eventType)).toBe('AI');
  });

  it('every layer carries the SAME correlation id, so one piece of work is followable', async () => {
    publishAIRequestCreated(CTX, 'TACTICAL');
    publishAIAgentStarted(CTX, 'TACTICAL');
    publishAIModelInvoked(CTX, { model: 'claude-sonnet-4', provider: 'anthropic', tokens: 900 });
    publishAIAgentCompleted(CTX, 'TACTICAL', 'anthropic', 900);
    await settle();

    expect(new Set(published.map((e) => e.correlationId))).toEqual(new Set([JOB]));
    expect(new Set(published.map((e) => e.subjectId))).toEqual(new Set([JOB]));
    // and the frame keeps it, so a monitor can group without reading a payload
    expect(published.map((e) => project(e).correlationId)).toEqual([JOB, JOB, JOB, JOB]);
  });

  it('tells the four components apart without a card for each', async () => {
    publishAIRequestCreated(CTX, 'TACTICAL');
    publishAIAgentStarted(CTX, 'TACTICAL');
    publishAIModelInvoked(CTX, { model: 'claude-sonnet-4', provider: 'anthropic', tokens: 1 });
    publishAIInferenceStarted(CTX, 'stub-vision');
    publishAIOrchestrationStarted(CTX, 'SQUAD', 'SELL_OR_KEEP');
    await settle();

    expect(published.map((e) => (e.payload as Row).component).sort())
      .toEqual(['AGENT', 'INFERENCE', 'MODEL', 'ORCHESTRATION', 'REQUEST']);
    const ids = visibleFabricSources().map((s) => s.id);
    for (const invented of ['gateway', 'engines', 'agents', 'model-registry', 'super-ai', 'video-intelligence']) {
      expect(`${invented} is a source: ${ids.includes(invented)}`).toBe(`${invented} is a source: false`);
    }
    expect(sourceLanes()).toEqual([
      'Clubs', 'Users', 'Players', 'Training', 'Matches',
      'Transfers', 'Coach Market', 'Medical', 'Media', 'AI', 'System',
    ]);
  });

  it('a failure carries a category and never the error', async () => {
    publishAIAgentFailed(CTX, 'TACTICAL', new Error(SECRETS.providerError));
    publishAIInferenceFailed(CTX, 'stub-vision', { message: 'ECONNREFUSED 10.0.0.4:443' });
    await settle();

    expect((one('ai.agent.failed').payload as Row).failureCategory).toBe('validation_error');
    expect((one('ai.inference.failed').payload as Row).failureCategory).toBe('provider_unavailable');
    const wire = JSON.stringify(published);
    expect(wire).not.toContain('Tomás');
    expect(wire).not.toContain('10.0.0.4');
  });

  it('a model invocation is one fact with an outcome, not two names', async () => {
    publishAIModelInvoked(CTX, { model: 'claude-sonnet-4', provider: 'anthropic', tokens: 900 });
    publishAIModelInvoked(CTX, { model: 'claude-sonnet-4', provider: 'anthropic', error: { status: 429 } });
    await settle();

    const calls = published.filter((e) => e.eventType === 'ai.model.invoked');
    expect(calls).toHaveLength(2);
    expect(calls.map((e) => (e.payload as Row).outcome)).toEqual(['SUCCEEDED', 'FAILED']);
    expect(calls.map((e) => (e.payload as Row).failureCategory)).toEqual([null, 'rate_limited']);
  });

  it('an orchestration says whether a cached decision served it', async () => {
    publishAIOrchestrationCompleted(CTX, 'SQUAD', 'SELL_OR_KEEP', true);
    await settle();
    expect(one('ai.orchestration.completed').payload).toEqual({
      domain: 'SQUAD', decisionType: 'SELL_OR_KEEP', cacheHit: true, component: 'ORCHESTRATION',
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3 · THE MODEL FUNNEL — llmCall
// ══════════════════════════════════════════════════════════════════════════════

describe('every model call goes through one place', () => {
  // The adapter caches its provider client on first construction and offers no
  // reset, so the order here is deliberate: the two tests that need the STUB
  // backend run before any test installs a key. Isolating the module instead
  // would re-evaluate the producer and its zod schemas, which the schema
  // registry correctly refuses as a redefinition of a shipped contract.
  const withKey = async (fn: () => Promise<unknown>) => {
    const original = config.anthropic.apiKey;
    (config.anthropic as Row).apiKey = SECRETS.apiKey;
    try { return await fn(); } finally {
      (config.anthropic as Row).apiKey = original;
    }
  };

  it('the stub backend is recorded as an invocation too, with its own family', async () => {
    const r = await llmCall({
      prompt: SECRETS.prompt,
      observe: { runId: JOB, clubId: CLUB, correlationId: JOB },
    });
    await settle();

    expect(r.backend).toBe('stub');
    expect(one('ai.model.invoked').payload).toMatchObject({
      modelFamily: 'familista-stub', provider: 'stub', outcome: 'SUCCEEDED',
    });
    expect(JSON.stringify(published)).not.toContain('Tomás');
  });

  it('a caller that did not ask to be observed publishes nothing', async () => {
    await llmCall({ prompt: SECRETS.prompt });
    await settle();
    expect(types()).toEqual([]);
  });

  it('a broken fabric does not fail the model call', async () => {
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('outbox is down'); },
      async read() { return []; },
    } as EventTransport);

    const r = await llmCall({
      prompt: SECRETS.prompt, observe: { runId: JOB, clubId: CLUB, correlationId: JOB },
    });
    await settle();
    expect(r.text).toContain('[stub]');
    setEventTransport(transport);
  });

  it('publishes exactly one ai.model.invoked, carrying no prompt, answer or key', async () => {
    await withKey(async () => {
      const r = await llmCall({
        system: SECRETS.systemPrompt, prompt: SECRETS.prompt, maxTokens: 1024,
        observe: { runId: JOB, clubId: CLUB, correlationId: JOB },
      });
      expect(r.text).toContain('Hertha');   // the answer really came back
    });
    await settle();

    expect(types()).toEqual(['ai.model.invoked']);
    expect(one('ai.model.invoked').payload).toEqual({
      modelFamily: 'claude-sonnet', provider: 'anthropic',
      outcome: 'SUCCEEDED', failureCategory: null,
      tokenBucket: 'UNDER_10K', component: 'MODEL',
    });

    const wire = JSON.stringify(published);
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(`${name}: ${wire.includes(secret)}`).toBe(`${name}: false`);
    }
  });

  it('a provider refusal that quotes the prompt back publishes a category only', async () => {
    _sdkBehaviour = 'throw';
    await withKey(async () => {
      await expect(llmCall({
        prompt: SECRETS.prompt,
        observe: { runId: JOB, clubId: CLUB, correlationId: JOB },
      })).rejects.toThrow(/invalid_request_error/);   // the caller still sees it all
    });
    await settle();

    expect(types()).toEqual(['ai.model.invoked']);
    const e = one('ai.model.invoked');
    expect((e.payload as Row).outcome).toBe('FAILED');
    expect((e.payload as Row).failureCategory).toBe('validation_error');
    const wire = JSON.stringify(published);
    expect(wire).not.toContain('Tomás');
    expect(wire).not.toContain('Müller');
    expect(wire).not.toContain('ACL');
    expect(wire).not.toContain('invalid_request_error');
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// 4 · REAL SERVICES
// ══════════════════════════════════════════════════════════════════════════════

describe('queueing an agent job', () => {
  const ACT = { userId: ACTOR, clubId: CLUB };

  it('publishes exactly one ai.request.created, after the row exists', async () => {
    const job = await automation.enqueueAgentJob(ACT as never, {
      agent: 'TACTICAL' as never, kind: SECRETS.jobKind, teamId: TEAM,
      input: { prompt: SECRETS.prompt, note: SECRETS.scoutingNote } as never,
    } as never);
    await settle();

    expect(types()).toEqual(['ai.request.created']);
    expect(state.jobs).toHaveLength(1);
    const e = one('ai.request.created');
    expect(e.subjectId).toBe(job.id);
    expect(e.correlationId).toBe(job.id);
    expect(e.clubId).toBe(CLUB);
    expect(e.payload).toEqual({ agent: 'TACTICAL', component: 'REQUEST' });
  });

  it('carries neither the input nor the free-text job kind', async () => {
    await automation.enqueueAgentJob(ACT as never, {
      agent: 'TACTICAL' as never, kind: SECRETS.jobKind, teamId: TEAM,
      input: { prompt: SECRETS.prompt, note: SECRETS.scoutingNote } as never,
    } as never);
    await settle();

    const wire = JSON.stringify(published);
    expect(wire).not.toContain(SECRETS.prompt);
    expect(wire).not.toContain(SECRETS.scoutingNote);
    // `kind` is free text up to eighty characters and does not travel at all
    expect(wire).not.toContain(SECRETS.jobKind);
    expect(wire).not.toContain('ACL');
  });

  it('a rejected enqueue publishes nothing', async () => {
    await expect(automation.enqueueAgentJob(ACT as never, {
      agent: 'TACTICAL' as never, kind: '', input: {} as never,
    } as never)).rejects.toThrow();
    await expect(automation.enqueueAgentJob(ACT as never, {
      agent: 'TACTICAL' as never, kind: 'x'.repeat(81), input: {} as never,
    } as never)).rejects.toThrow();
    await settle();

    expect(types()).toEqual([]);
    expect(state.jobs).toHaveLength(0);
  });
});

describe('video inference', () => {
  const seed = (over: Row = {}) => {
    state.ingests.push({
      id: 'ingest-1', videoAssetId: 'asset-1', stage: 'FUSED', status: 'RUNNING',
      progress: 0.4, inferenceProvider: 'stub-vision', error: null, notes: null, ...over,
    });
  };

  it('reaching COMPLETED publishes exactly one ai.inference.completed', async () => {
    seed();
    await vision.transitionIngest({ userId: ACTOR, clubId: CLUB } as never, 'ingest-1', {
      stage: 'COMPLETED',
    } as never);
    await settle();

    expect(types()).toEqual(['ai.inference.completed']);
    expect(one('ai.inference.completed').payload)
      .toEqual({ provider: 'stub-vision', component: 'INFERENCE' });
  });

  it('reporting the same terminal stage twice publishes once', async () => {
    seed();
    await vision.transitionIngest({ userId: ACTOR } as never, 'ingest-1', { stage: 'COMPLETED' } as never);
    await settle();
    published = [];

    await vision.transitionIngest({ userId: ACTOR } as never, 'ingest-1', { stage: 'COMPLETED' } as never);
    await settle();
    expect(types()).toEqual([]);
  });

  it('a failure publishes a category and never the provider text', async () => {
    seed();
    await vision.failIngest({ userId: ACTOR } as never, 'ingest-1', SECRETS.providerError);
    await settle();

    expect(types()).toEqual(['ai.inference.failed']);
    expect((one('ai.inference.failed').payload as Row).failureCategory).toBe('validation_error');
    const wire = JSON.stringify(published);
    expect(wire).not.toContain('Tomás');
    expect(wire).not.toContain('invalid_request_error');
  });

  it('failing a job that already failed publishes nothing the second time', async () => {
    seed({ status: 'FAILED', stage: 'FAILED' });
    await vision.failIngest({ userId: ACTOR } as never, 'ingest-1', 'already gone');
    await settle();
    expect(types()).toEqual([]);
  });

  it('an intermediate stage is progress, not a lifecycle event', async () => {
    seed({ stage: 'DEMUXED', status: 'RUNNING' });
    await vision.transitionIngest({ userId: ACTOR } as never, 'ingest-1', {
      stage: 'INFERRED', progress: 0.5,
    } as never);
    await settle();
    expect(types()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5 · AI IS NOT MEDIA
// ══════════════════════════════════════════════════════════════════════════════

describe('AI and Media stay apart', () => {
  it('no media name is registered under the AI source, and no AI name under media', () => {
    for (const spec of fabricEventsForSource('ai')) {
      expect(`${spec.type}: ${spec.type.startsWith('media.')}`).toBe(`${spec.type}: false`);
      expect(`${spec.type} source: ${spec.source}`).toBe(`${spec.type} source: ai`);
    }
    for (const spec of fabricEventsForSource('media')) {
      expect(`${spec.type}: ${/inference|agent|model|orchestration/.test(spec.type)}`)
        .toBe(`${spec.type}: false`);
    }
  });

  it('an inference event carries no storage key, URL or media detail', async () => {
    publishAIInferenceStarted(CTX, 'stub-vision');
    publishAIInferenceCompleted(CTX, 'stub-vision');
    await settle();

    for (const e of published) {
      expect(Object.keys(e.payload as Row).sort()).toEqual(['component', 'provider']);
    }
    expect(JSON.stringify(published)).not.toContain(SECRETS.endpoint);
  });

  it('the AI producer is not reachable from the Media asset service', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'fabric', 'media', 'media-asset.service.ts'), 'utf8',
    );
    expect(`media service imports ai.producer: ${src.includes('ai.producer')}`)
      .toBe('media service imports ai.producer: false');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6 · NOTHING FROM A PROMPT REACHES OBSERVABILITY
// ══════════════════════════════════════════════════════════════════════════════

describe('redaction', () => {
  it('no payload field in the AI producer could hold free text a caller supplied', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'fabric', 'producers', 'ai.producer.ts'), 'utf8',
    );
    // The CODE, not the prose. The file's own comments name the things it
    // refuses to carry, and matching those would be matching the explanation
    // rather than the behaviour.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    // Every helper's arguments are enums, numbers, booleans or values the
    // producer normalises. A field named for free text is the shape of a
    // future leak, whatever its type says today.
    expect(code).not.toMatch(/prompt|response|completion|embedding|apiKey|secret|rationale/i);
  });

  it('every AI payload validates against its strict schema', async () => {
    publishAIRequestCreated(CTX, 'TACTICAL');
    publishAIAgentStarted(CTX, 'TACTICAL');
    publishAIAgentCompleted(CTX, 'TACTICAL', 'anthropic', 3100);
    publishAIAgentFailed(CTX, 'TACTICAL', new Error('boom'));
    publishAIModelInvoked(CTX, { model: 'claude-sonnet-4', provider: 'anthropic', tokens: 12 });
    publishAIInferenceStarted(CTX, 'stub-vision');
    publishAIInferenceCompleted(CTX, 'stub-vision');
    publishAIInferenceFailed(CTX, 'stub-vision', { status: 503 });
    publishAIOrchestrationStarted(CTX, 'SQUAD', 'SELL_OR_KEEP');
    publishAIOrchestrationCompleted(CTX, 'SQUAD', 'SELL_OR_KEEP', false);
    await settle();

    expect(published).toHaveLength(10);
    for (const e of published) {
      const check = validateEventPayload(e.eventType, 1, e.payload);
      expect(`${e.eventType}: ${check.ok ? 'ok' : JSON.stringify((check as Row).issues)}`)
        .toBe(`${e.eventType}: ok`);
    }
  });

  it('a strict schema refuses a prompt, a response or a key added later', () => {
    expect(validateEventPayload('ai.request.created', 1, {
      agent: 'TACTICAL', component: 'REQUEST', prompt: SECRETS.prompt,
    }).ok).toBe(false);
    expect(validateEventPayload('ai.agent.completed', 1, {
      agent: 'TACTICAL', provider: 'anthropic', tokenBucket: 'UNDER_10K',
      component: 'AGENT', output: SECRETS.response,
    }).ok).toBe(false);
    expect(validateEventPayload('ai.model.invoked', 1, {
      modelFamily: 'claude-sonnet', provider: 'anthropic', outcome: 'SUCCEEDED',
      failureCategory: null, tokenBucket: null, component: 'MODEL', apiKey: SECRETS.apiKey,
    }).ok).toBe(false);
    // and a raw token count is not a bucket
    expect(validateEventPayload('ai.agent.completed', 1, {
      agent: 'TACTICAL', provider: 'anthropic', tokenBucket: 3100, component: 'AGENT',
    }).ok).toBe(false);
    // and an unrecognised failure category is not a free-text error
    expect(validateEventPayload('ai.agent.failed', 1, {
      agent: 'TACTICAL', failureCategory: SECRETS.providerError, component: 'AGENT',
    }).ok).toBe(false);
  });

  it('a frame carries no payload, and names nobody', async () => {
    publishAIAgentStarted(CTX, 'TACTICAL');
    await settle();

    const frames = published.map((e) => project(e, 'STORED'));
    await resolveSubjects(frames);
    const frame = frames[0] as Row;
    expect(frame.payload).toBeUndefined();
    expect(frame.metadata).toBeUndefined();
    // MODEL is a safe subject kind — an opaque run id, which §3 permits —
    // and it is not a kind the resolver knows how to name.
    expect(frame.subjectId).toBe(JOB);
    expect(frame.subjectType).toBe('MODEL');
    expect(frame.subjectLabel).toBeNull();
  });

  it('the worker hands the producer no prompt, output or error text', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'workers', 'ai-agent.worker.ts'), 'utf8',
    );
    const calls = [...src.matchAll(/publishAIAgent\w+\(([\s\S]{0,220}?)\);/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const args of calls) {
      for (const forbidden of ['job.input', 'result.text', 'deterministic.text', 'job.kind', 'prompt', 'system']) {
        expect(`${forbidden} passed: ${args.includes(forbidden)}`).toBe(`${forbidden} passed: false`);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7 · THE CATALOGUE
// ══════════════════════════════════════════════════════════════════════════════

describe('the catalogue', () => {
  const PRODUCED = [
    'ai.request.created',
    'ai.agent.started', 'ai.agent.completed', 'ai.agent.failed',
    'ai.model.invoked',
    'ai.inference.started', 'ai.inference.completed', 'ai.inference.failed',
    'ai.orchestration.started', 'ai.orchestration.completed',
  ];

  it('registers every produced type under the ai source, about a MODEL', () => {
    for (const type of PRODUCED) {
      const spec = fabricEvent(type);
      expect(`${type} registered: ${!!spec}`).toBe(`${type} registered: true`);
      expect(`${type} source: ${spec!.source}`).toBe(`${type} source: ai`);
      expect(`${type} entity: ${spec!.entityType}`).toBe(`${type} entity: MODEL`);
      expect(`${type} produced: ${spec!.produced}`).toBe(`${type} produced: true`);
      expect(sourceLaneFor(type)).toBe('AI');
      expect(validateEventPayload(type, 1, null).ok).toBe(false);
    }
  });

  it('says plainly which names are declared and not yet published', () => {
    const declared = fabricEventsForSource('ai').filter((s) => !s.produced).map((s) => s.type).sort();
    expect(declared).toEqual([
      'ai.alert.raised', 'ai.analysis.completed',
      'ai.request.completed', 'ai.request.failed',
      'ai.task.completed', 'ai.task.failed', 'ai.task.started',
      // The one model-registry name the AI lane carries that still has no
      // producer. `model.deployment.completed` got one — `activateModel`
      // publishes it — but nothing in this build evaluates a model at all, so
      // this stays declared and unproduced rather than being given a fiction.
      'model.evaluation.completed',
    ]);
  });

  it('and everything else under the ai prefix IS published by this build', () => {
    // The AI source owns three event domains — `ai`, `model` and `agent` —
    // and the model-registry names under `model.` were registered elsewhere.
    // This producer owns the `ai.` prefix, which is what is pinned here.
    const produced = fabricEventsForSource('ai')
      .filter((s) => s.produced && s.type.startsWith('ai.'))
      .map((s) => s.type).sort();
    expect(produced).toEqual([...PRODUCED].sort());
  });

  it('shares its lane with the model-registry names, and adds no card for them', () => {
    const owned = fabricEventsForSource('ai').map((s) => s.type);
    expect(owned.some((t) => t.startsWith('model.'))).toBe(true);
    for (const t of owned) expect(sourceLaneFor(t)).toBe('AI');
  });

  it('every declared-but-unproduced type still has a strict schema to be built against', () => {
    for (const spec of fabricEventsForSource('ai').filter((s) => !s.produced)) {
      // The names seeded by the taxonomy rather than by this producer predate
      // the schema registry and have no schema of their own.
      if (['ai.alert.raised', 'ai.analysis.completed',
           'model.evaluation.completed'].includes(spec.type)) continue;
      expect(`${spec.type} has a schema: ${validateEventPayload(spec.type, 1, null).ok === false}`)
        .toBe(`${spec.type} has a schema: true`);
    }
  });

  it('invents no orchestrator or super-AI producer', () => {
    for (const name of ['ai.superai.started', 'ai.multiagent.started', 'ai.swarm.started']) {
      expect(`${name}: ${!!fabricEvent(name)}`).toBe(`${name}: false`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8 · THE FABRIC MUST NOT BE ABLE TO BREAK AI EXECUTION
// ══════════════════════════════════════════════════════════════════════════════

describe('when the fabric is broken', () => {
  it('a transport that throws does not fail the AI operation that caused it', async () => {
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('outbox is down'); },
      async read() { return []; },
    } as EventTransport);

    const job = await automation.enqueueAgentJob(
      { userId: ACTOR, clubId: CLUB } as never,
      { agent: 'TACTICAL' as never, kind: 'X', input: {} as never } as never,
    );
    state.ingests.push({
      id: 'ingest-9', videoAssetId: 'asset-9', stage: 'FUSED', status: 'RUNNING',
      progress: 0.4, inferenceProvider: 'stub-vision', error: null, notes: null,
    });
    const done = await vision.transitionIngest(
      { userId: ACTOR } as never, 'ingest-9', { stage: 'COMPLETED' } as never,
    );
    await settle();

    expect(job.id).toBeTruthy();
    expect(state.jobs).toHaveLength(1);
    expect(done.status).toBe('COMPLETED');
    setEventTransport(transport);
  });
});
