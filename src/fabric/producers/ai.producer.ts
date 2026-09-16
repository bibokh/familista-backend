// The AI domain, as a Data Fabric producer
// ─────────────────────────────────────────────────────────────────────────────
// ONE SOURCE, FOUR LAYERS. A request accepted, an agent run, a model
// invocation and a video inference are one source and one lane. They are told
// apart by their event NAME and by `component` — REQUEST, AGENT, MODEL,
// INFERENCE, ORCHESTRATION — never by a card of their own. The Gateway, the
// Engines, the Agents and Video Intelligence are components of one domain.
//
// WHAT NEVER TRAVELS
//
// The prompt. The system prompt. The response. The reasoning. The job's INPUT
// and its OUTPUT, both of which are arbitrary JSON a caller supplied. An
// embedding. A provider error string. An API key. A model deployment id.
//
// The rule that makes it enforceable is that this producer never accepts a
// free-text field. Every payload value is one of four things: a CLOSED ENUM
// (`AIAgent`, an outcome, a failure category), a BUCKET (tokens), a BOOLEAN, or
// a token this file NORMALISES itself. Nothing is passed through.
//
// THREE CASES WORTH NAMING, BECAUSE THEY LOOK SAFE
//
//   · a JOB KIND. `AIAgentJob.kind` is free text up to eighty characters —
//     `TACTICAL.MATCH_REVIEW` today, and whatever a caller passes tomorrow. The
//     closed `AIAgent` enum travels instead; the kind does not.
//   · a PROVIDER ERROR. It is the field most likely to quote the prompt back:
//     a rejected request is echoed in the rejection. Errors are normalised into
//     six categories here, and the text stays on the job row.
//   · a MODEL ID. `claude-sonnet-4-20250514` is public, but a deployment id on
//     another provider is not, so §4's rule is applied to all of them: what
//     travels is the FAMILY this file derives, never the identifier it was
//     given.
//
// AI IS NOT MEDIA
//
// A video being uploaded and transcoded is Media and is published there. A
// model watching it is AI and is published here. The two lifecycles share a
// video asset and nothing else: no media event is republished under this
// source, and no inference event carries a storage key, a URL or a frame.

import { z } from 'zod';
import { registerFabricEvent } from '../registry/event-registry';
import { registerFabricSchema } from '../registry/schema-registry';
import { publishFabricEventDetached } from '../registry/publisher';
import type { EventSourceType } from '../event-envelope';

/** The source every event in this file belongs to. Registered in `source-registry`. */
export const AI_SOURCE_ID = 'ai';

const token = (max = 48) => z.string().min(1).max(max).nullable();

/**
 * Which part of the AI platform this is about.
 *
 * The one field that tells a Gateway event from an Engine event from an Agent
 * run, and the reason none of them needs a source card of its own.
 */
const component = z.enum(['REQUEST', 'AGENT', 'MODEL', 'INFERENCE', 'ORCHESTRATION']);

/** Which agent. The `AIAgent` enum — closed, and not the free-text job kind. */
const agent = token();

/** Which provider, as a CATEGORY. `anthropic`, `stub`, `deterministic`. */
const provider = token();

/**
 * Which model FAMILY.
 *
 * Never the identifier the caller passed. §4 says to expose only a generic
 * family where model identity may be sensitive, and applying that to every
 * provider is cheaper than deciding per provider which ones are safe.
 */
const modelFamily = token();

/**
 * How many tokens, as a BUCKET.
 *
 * §3 permits a token-count bucket. An exact count is a proxy for how long the
 * prompt was, which on a small population is a proxy for what it contained.
 */
const tokenBucket = z.enum(['UNDER_1K', 'UNDER_10K', 'UNDER_100K', 'OVER_100K']).nullable();

/**
 * Why it failed, as one of six.
 *
 * Normalised HERE, from the error, and never the error itself. A provider's
 * message routinely quotes the request that caused it — which is the prompt.
 */
const failureCategory = z.enum([
  'timeout', 'provider_unavailable', 'rate_limited',
  'validation_error', 'not_authorised', 'internal_error',
]);

export function registerAIProducer(): void {
  // ── the request ────────────────────────────────────────────────────────────

  registerFabricEvent({
    type: 'ai.request.created',
    describes: 'An AI job was accepted and queued',
    classification: 'INTERNAL',
    entityType: 'MODEL',
  });
  registerFabricSchema({
    eventType: 'ai.request.created', version: 1,
    // Not the `input`. It is arbitrary JSON a caller supplied and is the
    // prompt in everything but name.
    describes: 'That a job was queued, and for which agent. Never its input',
    schema: z.object({ agent, component }).strict(),
  });

  // Declared, not produced. An `AIAgentJob` is the request AND the run: one
  // row, one lifecycle. Its completion is `ai.agent.completed` and its failure
  // is `ai.agent.failed`, published from the worker that actually finished it.
  // A second name for the same moment would be the double-publish §10 warns
  // about, so these are reserved for the day a request spans more than one run.
  for (const [type, describes] of [
    ['ai.request.completed', 'An AI request finished successfully'],
    ['ai.request.failed', 'An AI request did not finish'],
  ] as const) {
    registerFabricEvent({
      type, describes, classification: 'INTERNAL', entityType: 'MODEL', produced: false,
    });
    registerFabricSchema({
      eventType: type, version: 1,
      describes: 'The outcome of a request spanning more than one run',
      schema: z.object({ agent, component }).strict(),
    });
  }

  // ── the agent run ──────────────────────────────────────────────────────────

  registerFabricEvent({
    type: 'ai.agent.started',
    describes: 'A worker claimed an AI agent job',
    classification: 'INTERNAL',
    entityType: 'MODEL',
  });
  registerFabricSchema({
    eventType: 'ai.agent.started', version: 1,
    // Published on the ATOMIC CLAIM: two workers racing for one job produce
    // one event, because only one `updateMany` matches a row still PENDING.
    describes: 'That a run began, and for which agent',
    schema: z.object({ agent, component }).strict(),
  });

  registerFabricEvent({
    type: 'ai.agent.completed',
    describes: 'An AI agent job finished successfully',
    classification: 'INTERNAL',
    entityType: 'MODEL',
  });
  registerFabricSchema({
    eventType: 'ai.agent.completed', version: 1,
    // Not the `output`, not the rationale, not the confidence, not the cost in
    // cents. What it produced is on the job row, read under authorisation.
    describes: 'That it succeeded, on which backend, in which token band',
    schema: z.object({ agent, provider, tokenBucket, component }).strict(),
  });

  registerFabricEvent({
    type: 'ai.agent.failed',
    describes: 'An AI agent job did not finish',
    classification: 'INTERNAL',
    entityType: 'MODEL',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'ai.agent.failed', version: 1,
    describes: 'That it failed, in one of six categories. Never the error text',
    schema: z.object({ agent, failureCategory, component }).strict(),
  });

  // ── the model invocation ───────────────────────────────────────────────────

  registerFabricEvent({
    type: 'ai.model.invoked',
    describes: 'A model was called, and how it answered',
    classification: 'INTERNAL',
    entityType: 'MODEL',
  });
  registerFabricSchema({
    eventType: 'ai.model.invoked', version: 1,
    // ONE name for both outcomes, because an invocation is one fact with a
    // result rather than two facts. `failureCategory` is null when it
    // succeeded, and the schema has no field for a prompt, a response or a key.
    describes: 'Which family answered, how it went, in which token band',
    schema: z.object({
      modelFamily, provider,
      outcome: z.enum(['SUCCEEDED', 'FAILED']),
      failureCategory: failureCategory.nullable(),
      tokenBucket, component,
    }).strict(),
  });

  // ── video inference ────────────────────────────────────────────────────────
  //
  // The AI half of a video's life. The Media half — uploaded, transcoded,
  // ready — is published under `source = media` and is not repeated here.

  registerFabricEvent({
    type: 'ai.inference.started',
    describes: 'A video was submitted for inference',
    classification: 'INTERNAL',
    entityType: 'MODEL',
  });
  registerFabricSchema({
    eventType: 'ai.inference.started', version: 1,
    // No storage key, no URL, no external job id — the last of those is a
    // handle on somebody else's system and is not ours to publish.
    describes: 'That inference was submitted, to which provider category',
    schema: z.object({ provider, component }).strict(),
  });

  registerFabricEvent({
    type: 'ai.inference.completed',
    describes: 'Inference on a video reached its terminal stage',
    classification: 'INTERNAL',
    entityType: 'MODEL',
  });
  registerFabricSchema({
    eventType: 'ai.inference.completed', version: 1,
    // Not what was detected. Events, tracks and analytics are the club's own
    // analysis and are read through the surfaces that authorise them.
    describes: 'That inference finished. Never what it found',
    schema: z.object({ provider, component }).strict(),
  });

  registerFabricEvent({
    type: 'ai.inference.failed',
    describes: 'Inference on a video failed',
    classification: 'INTERNAL',
    entityType: 'MODEL',
    auditRelevant: true,
  });
  registerFabricSchema({
    eventType: 'ai.inference.failed', version: 1,
    describes: 'That it failed, in one of six categories. Never the error text',
    schema: z.object({ provider, failureCategory, component }).strict(),
  });

  // ── orchestration ──────────────────────────────────────────────────────────

  registerFabricEvent({
    type: 'ai.orchestration.started',
    describes: 'A decision orchestration began',
    classification: 'INTERNAL',
    entityType: 'MODEL',
  });
  registerFabricSchema({
    eventType: 'ai.orchestration.started', version: 1,
    // The DOMAIN and the DECISION TYPE are the platform's own vocabulary for
    // which question is being asked. The FEATURES that answer it — the club's
    // data — are hashed by the orchestrator and travel nowhere near this.
    describes: 'Which kind of decision was asked for. Never the features',
    schema: z.object({ domain: token(), decisionType: token(), component }).strict(),
  });

  registerFabricEvent({
    type: 'ai.orchestration.completed',
    describes: 'A decision orchestration produced a result',
    classification: 'INTERNAL',
    entityType: 'MODEL',
  });
  registerFabricSchema({
    eventType: 'ai.orchestration.completed', version: 1,
    describes: 'That a decision was produced, and whether a cached one served it',
    schema: z.object({
      domain: token(), decisionType: token(), cacheHit: z.boolean(), component,
    }).strict(),
  });

  // ── declared, produced by nothing ──────────────────────────────────────────
  //
  // `AutomationRun` rows are created PENDING by the scheduler and nothing
  // drains them: there is no code path in this build that moves one to RUNNING,
  // SUCCESS or FAILED. A started event for a run that never starts would be
  // fiction, so the three names are reserved and the catalogue says they do not
  // occur. The day a runner exists it registers nothing new.
  for (const [type, describes] of [
    ['ai.task.started', 'A scheduled AI task run began'],
    ['ai.task.completed', 'A scheduled AI task run finished'],
    ['ai.task.failed', 'A scheduled AI task run failed'],
  ] as const) {
    registerFabricEvent({
      type, describes, classification: 'INTERNAL', entityType: 'MODEL', produced: false,
    });
    registerFabricSchema({
      eventType: type, version: 1,
      describes: 'The run’s outcome. Never its output or its error text',
      schema: z.object({
        taskKind: token(), failureCategory: failureCategory.nullable(), component,
      }).strict(),
    });
  }

  // ── the model registry ─────────────────────────────────────────────────────
  //
  // `model.deployment.completed` is in `event-taxonomy.ts`, not here, and its
  // domain is `model` rather than `ai` — which is why the AI source declares
  // three event domains and why this lane carries it. Only its payload shape is
  // declared here, because this is now the file that builds it.
  //
  // `model.evaluation.completed` stays unproduced beside it, and deliberately:
  // nothing in this build evaluates a model against a dataset, and a producer
  // for a flow that does not exist would be fiction.
  registerFabricSchema({
    eventType: 'model.deployment.completed', version: 1,
    // Not the SLUG. A slug is a name somebody typed and this file's whole
    // doctrine on model identity — see `modelFamily` above — is that the
    // identifier the caller chose does not travel. What does is which decision
    // this model makes, which is a closed enum, and how many peers stood down.
    describes: 'Which decision a model version was put in service for, and how many it replaced',
    schema: z.object({
      domain: token(),
      decisionType: token(),
      version: token(24),
      peersDeactivated: z.number().int().min(0).max(10_000),
      component,
    }).strict(),
  });
}

registerAIProducer();

// ── normalisation, which is where the privacy actually happens ───────────────

/**
 * A model identifier, reduced to a FAMILY.
 *
 * `claude-sonnet-4-20250514` becomes `claude-sonnet`. A deployment id that is
 * meaningless outside its provider becomes its first two segments and nothing
 * more. The point is not to be clever about model naming; it is that whatever
 * arrives, a bounded and uninformative token leaves.
 */
export function modelFamilyOf(model: string | null | undefined): string | null {
  const raw = String(model ?? '').trim().toLowerCase();
  if (!raw) return null;
  const parts = raw.split(/[-_/:.]/).filter(Boolean);
  // Drop anything that is a version, a date or an opaque run of digits, then
  // keep at most the first two words. A family is a word or two, never a build.
  const words = parts.filter((p) => !/^\d/.test(p) && !/^v\d/.test(p)).slice(0, 2);
  return words.length ? words.join('-').slice(0, 48) : null;
}

/**
 * An error, reduced to one of six categories.
 *
 * Reads only the SHAPE of the message — never forwards it. Anything this
 * function does not recognise is `internal_error`, which is the safe direction
 * for a classifier to fail in: a category that says nothing beats a passthrough
 * that says everything.
 */
export function failureCategoryOf(err: unknown): z.infer<typeof failureCategory> {
  const status = Number(
    (err as { status?: unknown; statusCode?: unknown })?.status
    ?? (err as { statusCode?: unknown })?.statusCode
    ?? Number.NaN,
  );
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'not_authorised';
  if (status === 400 || status === 422) return 'validation_error';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 502 || status === 503) return 'provider_unavailable';

  const text = String((err as { message?: unknown })?.message ?? err ?? '').toLowerCase();
  if (/timed? ?out|etimedout|deadline|stalled/.test(text)) return 'timeout';
  if (/rate.?limit|too many requests|quota|overloaded/.test(text)) return 'rate_limited';
  if (/unauthor|forbidden|invalid api key|permission/.test(text)) return 'not_authorised';
  if (/econnrefused|enotfound|unavailable|bad gateway|socket hang up/.test(text)) return 'provider_unavailable';
  if (/invalid|validation|required|must be|malformed|not allowed/.test(text)) return 'validation_error';
  return 'internal_error';
}

export type TokenBucket = z.infer<typeof tokenBucket>;

/** How many tokens, roughly. §3 permits a bucket; an exact count is a proxy. */
export function bucketTokens(count: number | null | undefined): TokenBucket {
  if (count === null || count === undefined) return null;
  const n = Number(count);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1_000) return 'UNDER_1K';
  if (n < 10_000) return 'UNDER_10K';
  if (n < 100_000) return 'UNDER_100K';
  return 'OVER_100K';
}

// ── the helpers the AI flows call ────────────────────────────────────────────

/**
 * Which run, and whose.
 *
 * `runId` is the operational artifact — an agent job, an ingest job, a decision
 * — and §3 names an opaque requestId, taskId or agentRunId as permitted
 * metadata. `correlationId` is what ties the four layers together: a request,
 * the run that executes it and the model it calls all carry the SAME id, so a
 * future AI monitor can follow one piece of work across components without any
 * of them carrying what the work was about.
 */
export interface AIContext {
  runId: string;
  clubId?: string | null;
  teamId?: string | null;
  /** The agent job id, for everything that happens under one piece of work. */
  correlationId?: string | null;
  actorUserId?: string | null;
  sourceType?: EventSourceType;
}

function publish(
  eventType: string,
  ctx: AIContext,
  extra: Record<string, unknown>,
): void {
  publishFabricEventDetached({
    eventType,
    clubId: ctx.clubId ?? null,
    teamId: ctx.teamId ?? null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'MODEL',
    subjectId: ctx.runId,
    sourceType: ctx.sourceType ?? 'AI',
    correlationId: ctx.correlationId ?? null,
    payload: extra,
  });
}

export function publishAIRequestCreated(ctx: AIContext, agentName: string | null): void {
  publish('ai.request.created', ctx, { agent: agentName ?? null, component: 'REQUEST' });
}

export function publishAIAgentStarted(ctx: AIContext, agentName: string | null): void {
  publish('ai.agent.started', ctx, { agent: agentName ?? null, component: 'AGENT' });
}

export function publishAIAgentCompleted(
  ctx: AIContext, agentName: string | null, backend: string | null, tokens: number | null | undefined,
): void {
  publish('ai.agent.completed', ctx, {
    agent: agentName ?? null, provider: backend ?? null,
    tokenBucket: bucketTokens(tokens), component: 'AGENT',
  });
}

export function publishAIAgentFailed(ctx: AIContext, agentName: string | null, err: unknown): void {
  publish('ai.agent.failed', ctx, {
    agent: agentName ?? null, failureCategory: failureCategoryOf(err), component: 'AGENT',
  });
}

export function publishAIModelInvoked(
  ctx: AIContext,
  args: { model?: string | null; provider?: string | null; tokens?: number | null; error?: unknown },
): void {
  const failed = args.error !== undefined && args.error !== null;
  publish('ai.model.invoked', ctx, {
    modelFamily: modelFamilyOf(args.model),
    provider: args.provider ?? null,
    outcome: failed ? 'FAILED' : 'SUCCEEDED',
    failureCategory: failed ? failureCategoryOf(args.error) : null,
    tokenBucket: bucketTokens(args.tokens),
    component: 'MODEL',
  });
}

export function publishAIInferenceStarted(ctx: AIContext, providerName: string | null): void {
  publish('ai.inference.started', ctx, { provider: providerName ?? null, component: 'INFERENCE' });
}

/**
 * A model version was put into service.
 *
 * Called by `ai-model-registry.activateModel` after its transaction and its
 * audit write. Activating an already-active model still moves `releasedAt` and
 * still writes an audit row, so the caller announces what the transaction did
 * rather than what it was asked to do.
 */
export function publishModelDeploymentCompleted(
  // Its own shape rather than `AIContext`: that context is keyed by a `runId`,
  // and a deployment is not a run. Nothing is executing here — a row was marked
  // active.
  ctx: { modelId: string; clubId?: string | null; actorUserId?: string | null; sourceType?: EventSourceType },
  facts: { domain: string; decisionType: string; version: string | number; peersDeactivated: number },
): void {
  publishFabricEventDetached({
    eventType: 'model.deployment.completed',
    clubId: ctx.clubId ?? null,
    teamId: null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'MODEL',
    subjectId: ctx.modelId,
    sourceType: ctx.sourceType ?? 'SERVICE',
    payload: {
      domain: String(facts.domain).slice(0, 48) || null,
      decisionType: String(facts.decisionType).slice(0, 48) || null,
      version: String(facts.version).slice(0, 24) || null,
      peersDeactivated: Math.max(0, Math.min(10_000, Math.trunc(facts.peersDeactivated))),
      component: 'MODEL',
    },
  });
}

export function publishAIInferenceCompleted(ctx: AIContext, providerName: string | null): void {
  publish('ai.inference.completed', ctx, { provider: providerName ?? null, component: 'INFERENCE' });
}

export function publishAIInferenceFailed(
  ctx: AIContext, providerName: string | null, err: unknown,
): void {
  publish('ai.inference.failed', ctx, {
    provider: providerName ?? null, failureCategory: failureCategoryOf(err), component: 'INFERENCE',
  });
}

export function publishAIOrchestrationStarted(
  ctx: AIContext, domain: string | null, decisionType: string | null,
): void {
  publish('ai.orchestration.started', ctx, {
    domain: clip(domain), decisionType: clip(decisionType), component: 'ORCHESTRATION',
  });
}

export function publishAIOrchestrationCompleted(
  ctx: AIContext, domain: string | null, decisionType: string | null, cacheHit: boolean,
): void {
  publish('ai.orchestration.completed', ctx, {
    domain: clip(domain), decisionType: clip(decisionType), cacheHit, component: 'ORCHESTRATION',
  });
}

/** A bounded token. Nothing here accepts an unbounded string. */
function clip(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, 48) : null;
}
