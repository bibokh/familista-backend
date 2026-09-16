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

/**
 * What an alert or an analysis is ABOUT, without naming which one.
 *
 * `AIAlert` and `AIRecommendation` both carry an optional `playerId`, and a
 * player id on a fatigue alert is a health disclosure about an identifiable
 * person — on an academy squad, about a child. The scope says a player was the
 * subject; it never says which, and no id or team travels beside it.
 */
const scope = z.enum(['PLAYER', 'TEAM', 'MATCH', 'CLUB']);

/**
 * How the alert classified itself.
 *
 * `AIAlert.kind` is `z.string()` at the route — genuinely unconstrained, not an
 * enum — so this is capped rather than trusted. Every caller in this build
 * passes a token (`FATIGUE`, `FORMATION_DRIFT`, `DEVICE_STALE`), and the cap is
 * what keeps a caller who one day passes a sentence to a truncated fragment
 * rather than a paragraph on an operator's screen.
 */
const alertKind = token();

/** How urgent, as the platform's own `AlertSeverity` records it. */
const severity = token(24);

/**
 * A model's confidence, as a BAND.
 *
 * `AIRecommendation.score` is a 0..1 confidence in a judgement that is often
 * about one named player. The band is the operational fact — how sure it was —
 * without publishing a precise number attached to a person.
 */
const confidence = z.enum(['LOW', 'MEDIUM', 'HIGH']).nullable();

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

  // ── alerts and analyses ────────────────────────────────────────────────────
  //
  // Two names from `event-taxonomy.ts` that had no producer and, until the
  // Remaining Unproduced Events Review, a registration claiming they travelled
  // on another transport. They did not. `ai-ops.createAlert` writes an `AIAlert`
  // row and `createRecommendation` writes an `AIRecommendation` row, both real
  // and both durable, and the `AI_ALERT` / `AI_RECOMMENDATION` dispatchers in
  // `big-data/publisher.ts` that the registration pointed at are called by
  // nothing at all. The legacy mapping stays, because a reader of either name
  // should still find the other; what changes is that the fact now arrives.
  //
  // Only their payload shapes are declared here. Neither is registered here —
  // both are in the taxonomy and re-registering them would be refused.
  registerFabricSchema({
    eventType: 'ai.alert.raised', version: 1,
    // An alert is made of a classification and three pieces of prose: a title,
    // a message and an arbitrary JSON payload. The prose is what a model wrote
    // ABOUT A NAMED PERSON — "Okonkwo's load is 38% above his four-week mean"
    // is a plausible message — and none of it is here.
    describes: 'What kind of alert, how urgent, and what it is about. Never its text',
    schema: z.object({
      alertKind, severity, agent, scope,
    }).strict(),
  });

  registerFabricSchema({
    eventType: 'ai.analysis.completed', version: 1,
    // Same shape of risk and the same answer. `content` IS the recommendation —
    // "withdraw 9, press higher on the left" — and `score` is a judgement about
    // a person, so it travels as a band the way token counts do above.
    describes: 'Which agent answered, about what, and how confident. Never the recommendation',
    schema: z.object({
      analysisKind: alertKind, agent, scope, confidence,
    }).strict(),
  });

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

/** A score on 0..1 as one of three bands. Null when the model gave none. */
export function confidenceBand(score: number | null | undefined): 'LOW' | 'MEDIUM' | 'HIGH' | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (score < 0.4) return 'LOW';
  if (score < 0.75) return 'MEDIUM';
  return 'HIGH';
}

/** What the row is about, from the ids it carries. Never which one. */
export function scopeOf(
  row: { playerId?: string | null; teamId?: string | null; matchId?: string | null },
): 'PLAYER' | 'TEAM' | 'MATCH' | 'CLUB' {
  if (row.playerId) return 'PLAYER';
  if (row.teamId) return 'TEAM';
  if (row.matchId) return 'MATCH';
  return 'CLUB';
}

/**
 * A model raised an alert.
 *
 * Called by `ai-ops.createAlert` after the row exists. Neither the title, the
 * message nor the payload is a parameter, so there is no call site at which one
 * could be handed to this module.
 */
export function publishAIAlertRaised(
  ctx: { alertId: string; clubId: string; actorUserId?: string | null },
  facts: {
    alertKind: string; severity: string; agent: string | null;
    scope: 'PLAYER' | 'TEAM' | 'MATCH' | 'CLUB';
  },
): void {
  publishFabricEventDetached({
    eventType: 'ai.alert.raised',
    clubId: ctx.clubId,
    // Deliberately null. A team id beside a fatigue alert narrows its subject
    // to one squad, and `scope` already says what kind of thing it is about.
    teamId: null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'MODEL',
    subjectId: ctx.alertId,
    sourceType: 'AI',
    payload: {
      alertKind: String(facts.alertKind).slice(0, 48) || null,
      severity: String(facts.severity).slice(0, 24) || null,
      agent: facts.agent ? String(facts.agent).slice(0, 48) : null,
      scope: facts.scope,
    },
  });
}

/**
 * A model finished analysing something.
 *
 * Called by `ai-ops.createRecommendation` after the row exists. `content` is the
 * recommendation itself and is not a parameter.
 */
export function publishAIAnalysisCompleted(
  ctx: { recommendationId: string; clubId: string; actorUserId?: string | null },
  facts: {
    analysisKind: string; agent: string | null;
    scope: 'PLAYER' | 'TEAM' | 'MATCH' | 'CLUB';
    confidence: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  },
): void {
  publishFabricEventDetached({
    eventType: 'ai.analysis.completed',
    clubId: ctx.clubId,
    teamId: null,
    actorUserId: ctx.actorUserId ?? null,
    subjectType: 'MODEL',
    subjectId: ctx.recommendationId,
    sourceType: 'AI',
    payload: {
      analysisKind: String(facts.analysisKind).slice(0, 48) || null,
      agent: facts.agent ? String(facts.agent).slice(0, 48) : null,
      scope: facts.scope,
      confidence: facts.confidence,
    },
  });
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
