// The AI execution gate — paid model calls are denied unless the owner allows them
// ─────────────────────────────────────────────────────────────────────────────
// The gateway (gateway.ts) is the one door to a provider. This file is the
// policy that door applies before anything is sent, in four parts:
//
//   1. origin     every call must come from somewhere the platform authorised:
//                 an authenticated API request, or an agent job a signed-in
//                 person queued. A call from a timer, a background worker or
//                 anywhere unmarked is refused. There is no autonomous origin
//                 and no setting that creates one (AUTONOMOUS_AI_EXECUTION).
//   2. switch     the Platform Owner's AI EXECUTION switch, stored in the
//                 database (AiExecutionControl). No row, an unreadable row or
//                 an OFF row all mean OFF.
//   3. limits     tokens per request, per workflow and per agent run; tokens
//                 and estimated cost per UTC day and month for the platform;
//                 tokens per day for one club; concurrent calls. Each is
//                 configurable, defaults are deliberately small, and a value
//                 that is set but not a positive number refuses every call.
//   4. pricing    a price per model, from configuration (AI_MODEL_PRICING).
//                 A model without a price is not called: its cost could not be
//                 estimated, so it could not be budgeted.
//
// Budgets are RESERVED before the call, under one PostgreSQL advisory lock, for
// the most the call could use (input upper bound + the output cap), and settled
// to what the provider reports afterwards. Two calls can therefore never both
// fit into the last of a budget. A call whose usage the provider does not
// report keeps its full reservation: unknown is counted as the most it could
// have been, never as nothing.
//
// What these figures are: ESTIMATES. Reserved and settled amounts are computed
// here from token counts and configured prices. Provider-reported usage is the
// provider's count of one response. Neither is the provider's invoice, and no
// application-side budget can guarantee what an external provider charges.

import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError } from '../../utils/errors';

/** There is no autonomous AI execution in Familista, and no configuration that turns it on. */
export const AUTONOMOUS_AI_EXECUTION = false as const;

// ── origin ──────────────────────────────────────────────────────────────────

export type AiOrigin =
  /** An API request. The user is read when the call is made: `authenticate` runs after this is set. */
  | { kind: 'request'; userId: () => string | null }
  /** One AIAgentJob being run by the worker, for the person who queued it. */
  | { kind: 'agent-job'; jobId: string; agent: string; requestedBy: string | null }
  /** A timer or background worker. Never allowed to call a model. */
  | { kind: 'background'; label: string };

export interface AiScope {
  origin: AiOrigin;
  /** The executive workflow a call belongs to, when it belongs to one. Its budget applies. */
  workflowId?: string;
}

const scope = new AsyncLocalStorage<AiScope>();

export function currentAiScope(): AiScope | undefined {
  return scope.getStore();
}

/** Express: everything under the API runs as a request origin, for whoever `authenticate` resolves. */
export function aiRequestScope(req: Request, _res: Response, next: NextFunction): void {
  scope.run({ origin: { kind: 'request', userId: () => req.user?.id ?? null } }, next);
}

/** Background workers start inside this, so every timer they set inherits an origin that cannot call a model. */
export function runInBackgroundScope<T>(label: string, fn: () => T): T {
  return scope.run({ origin: { kind: 'background', label } }, fn);
}

/**
 * The worker runs one job inside this. A job never runs inside another job: an
 * agent that tried to start a second agent's work from its own would be
 * recursion, and is refused here as well as at every place a job is created.
 */
export function runAsAgentJob<T>(job: { id: string; agent: string; triggeredBy: string | null }, fn: () => T): T {
  if (scope.getStore()?.origin.kind === 'agent-job') {
    throw new ForbiddenError('An agent job cannot start another agent job');
  }
  return scope.run({ origin: { kind: 'agent-job', jobId: job.id, agent: job.agent, requestedBy: job.triggeredBy } }, fn);
}

/** Every model call made inside `fn` counts against this workflow's budget. */
export function withWorkflow<T>(workflowId: string, fn: () => T): T {
  const held = scope.getStore();
  if (!held) return fn();
  return scope.run({ ...held, workflowId }, fn);
}

/**
 * Called by every path that creates AI work (an AIAgentJob). Only a signed-in
 * person's request may: never an agent job (that would be agent-to-agent
 * execution), a timer, or code with no origin at all.
 */
export function assertMayCreateAgentWork(): void {
  const origin = scope.getStore()?.origin;
  if (!origin || origin.kind !== 'request' || !origin.userId()) {
    throw new ForbiddenError('AI work can only be started by a signed-in person\'s request');
  }
}

export type OriginVerdict =
  | { ok: true; agent: string | null; agentRunId: string | null; workflowId: string | null; origin: 'request' | 'agent-job' }
  | { ok: false; refusal: 'origin' | 'autonomous'; reason: string };

/** Whether the call being made now has an origin that may spend money. */
export function originVerdict(held: AiScope | undefined = scope.getStore()): OriginVerdict {
  const workflowId = held?.workflowId ?? null;
  const o = held?.origin;
  if (!o) return { ok: false, refusal: 'origin', reason: 'This AI call has no authorised origin, so it is not made' };
  if (o.kind === 'background') {
    return { ok: false, refusal: 'autonomous', reason: 'Background and scheduled AI calls are not allowed' };
  }
  if (o.kind === 'agent-job') {
    if (!o.requestedBy) return { ok: false, refusal: 'origin', reason: 'This agent job has no authenticated requester' };
    return { ok: true, agent: o.agent, agentRunId: o.jobId, workflowId, origin: 'agent-job' };
  }
  if (!o.userId()) return { ok: false, refusal: 'origin', reason: 'AI calls need a signed-in person' };
  return { ok: true, agent: null, agentRunId: null, workflowId, origin: 'request' };
}

// ── configuration ───────────────────────────────────────────────────────────

export interface AiLimits {
  perRequestTokens: number;
  perWorkflowTokens: number;
  perAgentRunTokens: number;
  clubDailyTokens: number;
  dailyTokens: number;
  monthlyTokens: number;
  /** Estimated cost, in millionths of a US dollar. */
  dailyCostMicros: number;
  monthlyCostMicros: number;
  maxConcurrent: number;
}

/** A model's price in US dollars per million tokens, input and output priced apart. */
export interface ModelPrice { inputPerMTokUsd: number; outputPerMTokUsd: number }

export interface AiPolicyConfig {
  limits: AiLimits;
  /** Keyed by the provider's own model name. */
  pricing: Record<string, ModelPrice>;
  /** The names of settings that are set but invalid. Any entry refuses every call. */
  errors: string[];
}

/** Each limit, the setting that changes it, and its default. Tokens count input and output together. */
export const LIMIT_SETTINGS: ReadonlyArray<{ key: keyof AiLimits; env: string; fallback: number; usd?: true }> = [
  { key: 'perRequestTokens',  env: 'AI_MAX_TOKENS_PER_REQUEST',         fallback: 32_000 },
  { key: 'perWorkflowTokens', env: 'AI_MAX_TOKENS_PER_WORKFLOW',        fallback: 100_000 },
  { key: 'perAgentRunTokens', env: 'AI_MAX_TOKENS_PER_AGENT_RUN',       fallback: 50_000 },
  { key: 'clubDailyTokens',   env: 'AI_CLUB_DAILY_TOKEN_BUDGET',        fallback: 200_000 },
  { key: 'dailyTokens',       env: 'AI_PLATFORM_DAILY_TOKEN_BUDGET',    fallback: 200_000 },
  { key: 'monthlyTokens',     env: 'AI_PLATFORM_MONTHLY_TOKEN_BUDGET',  fallback: 2_000_000 },
  { key: 'dailyCostMicros',   env: 'AI_PLATFORM_DAILY_COST_BUDGET_USD', fallback: 2_000_000, usd: true },
  { key: 'monthlyCostMicros', env: 'AI_PLATFORM_MONTHLY_COST_BUDGET_USD', fallback: 20_000_000, usd: true },
  { key: 'maxConcurrent',     env: 'AI_MAX_CONCURRENT_REQUESTS',        fallback: 2 },
];

export const PRICING_SETTING = 'AI_MODEL_PRICING';

const positive = (n: number) => Number.isFinite(n) && n > 0;

export function aiPolicyConfig(env: Record<string, string | undefined> = process.env): AiPolicyConfig {
  const errors: string[] = [];
  const limits = {} as AiLimits;
  for (const s of LIMIT_SETTINGS) {
    const raw = env[s.env];
    if (raw === undefined || raw.trim() === '') { limits[s.key] = s.fallback; continue; }
    const n = Number(raw);
    if (!positive(n) || (!s.usd && !Number.isInteger(n))) { errors.push(s.env); limits[s.key] = 0; continue; }
    limits[s.key] = s.usd ? Math.round(n * 1_000_000) : n;
  }

  const pricing: Record<string, ModelPrice> = {};
  const raw = env[PRICING_SETTING];
  if (raw !== undefined && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      for (const [model, p] of Object.entries(parsed as Record<string, unknown>)) {
        const price = p as Partial<ModelPrice> | null;
        if (!price || !positive(Number(price.inputPerMTokUsd)) || !positive(Number(price.outputPerMTokUsd))) throw new Error('bad price');
        pricing[model] = { inputPerMTokUsd: Number(price.inputPerMTokUsd), outputPerMTokUsd: Number(price.outputPerMTokUsd) };
      }
    } catch {
      errors.push(PRICING_SETTING);
    }
  }
  return { limits, pricing, errors };
}

// ── estimates ───────────────────────────────────────────────────────────────

/** Message framing the provider adds around the text, generously. */
export const FRAMING_OVERHEAD_TOKENS = 64;

/**
 * The most input tokens a prompt can be counted as. A token stands for at
 * least one byte of the UTF-8 text, so a text cannot be more tokens than it is
 * bytes; the framing is added on top. Typical English is three to four bytes a
 * token, so this over-reserves, and the difference is released at settlement.
 */
export function inputTokenUpperBound(prompt: string, system?: string | null): number {
  return Buffer.byteLength(prompt, 'utf8') + Buffer.byteLength(system ?? '', 'utf8') + FRAMING_OVERHEAD_TOKENS;
}

/** Estimated cost in millionths of a dollar: a price per million tokens is a price in micro-dollars per token. */
export function costMicros(tokensIn: number, tokensOut: number, price: ModelPrice): number {
  return Math.ceil(tokensIn * price.inputPerMTokUsd + tokensOut * price.outputPerMTokUsd);
}

// ── the decision ────────────────────────────────────────────────────────────

/** What is already spent or reserved, read under the reservation lock. */
export interface UsageSnapshot {
  enabled: boolean;
  dayTokens: number;
  monthTokens: number;
  dayCostMicros: number;
  monthCostMicros: number;
  clubDayTokens: number;
  workflowTokens: number;
  agentRunTokens: number;
  inFlight: number;
}

export interface ReservationAsk {
  tokens: number;
  costMicros: number;
  workflowId: string | null;
  agentRunId: string | null;
}

export type BudgetRefusal =
  | 'disabled' | 'concurrency' | 'workflow-budget' | 'agent-budget' | 'budget' | 'daily-budget' | 'monthly-budget';

export type GateRefusal = BudgetRefusal | 'origin' | 'autonomous' | 'config' | 'pricing' | 'request-limit';

/** Refusals that mean a configured budget is used up: the dashboard's budget-limit events. */
export const BUDGET_LIMIT_REFUSALS: ReadonlyArray<GateRefusal> = [
  'request-limit', 'workflow-budget', 'agent-budget', 'budget', 'daily-budget', 'monthly-budget',
];

export type Verdict = { ok: true } | { ok: false; refusal: BudgetRefusal; reason: string };

/** Whether one more reservation fits. Pure: the same snapshot and ask always give the same answer. */
export function decide(s: UsageSnapshot, ask: ReservationAsk, limits: AiLimits): Verdict {
  const no = (refusal: BudgetRefusal, reason: string): Verdict => ({ ok: false, refusal, reason });
  if (!s.enabled) return no('disabled', 'Paid AI execution is switched off by the Platform Owner');
  if (s.inFlight >= limits.maxConcurrent) return no('concurrency', 'The platform is already making as many AI calls as it allows at once');
  if (ask.workflowId && s.workflowTokens + ask.tokens > limits.perWorkflowTokens) return no('workflow-budget', 'This workflow has used its AI allowance');
  if (ask.agentRunId && s.agentRunTokens + ask.tokens > limits.perAgentRunTokens) return no('agent-budget', 'This agent run has used its AI allowance');
  if (s.clubDayTokens + ask.tokens > limits.clubDailyTokens) return no('budget', 'The daily AI budget for this club is used up');
  if (s.dayTokens + ask.tokens > limits.dailyTokens || s.dayCostMicros + ask.costMicros > limits.dailyCostMicros) {
    return no('daily-budget', 'The platform\'s daily AI budget is used up');
  }
  if (s.monthTokens + ask.tokens > limits.monthlyTokens || s.monthCostMicros + ask.costMicros > limits.monthlyCostMicros) {
    return no('monthly-budget', 'The platform\'s monthly AI budget is used up');
  }
  return { ok: true };
}

/** One AiEgressRecord as far as budgets are concerned. */
export interface LedgerRow {
  createdAt: Date;
  clubId: string | null;
  workflowId: string | null;
  agentRunId: string | null;
  outcome: string;
  tokensIn: number | null;
  tokensOut: number | null;
  reservedTokens: number | null;
  costMicros: number | null;
  reservedCostMicros: number | null;
}

/** What a record counts for: the reported usage when there is one, else the whole reservation. */
export function chargedTokens(r: LedgerRow): number {
  return r.tokensIn !== null || r.tokensOut !== null ? (r.tokensIn ?? 0) + (r.tokensOut ?? 0) : (r.reservedTokens ?? 0);
}

export function chargedCostMicros(r: LedgerRow): number {
  return r.costMicros !== null ? r.costMicros : (r.reservedCostMicros ?? 0);
}

/**
 * The snapshot `decide` reads, computed from records. The PostgreSQL ledger
 * computes the same figures in SQL (ai-ledger.ts), and a test holds the two to
 * the same answers on the same rows.
 */
export function snapshotOf(
  rows: ReadonlyArray<LedgerRow>,
  q: { clubId: string | null; workflowId: string | null; agentRunId: string | null },
  enabled: boolean,
  now: Date = new Date(),
): UsageSnapshot {
  const { day, month } = budgetWindows(now);
  const inFlightSince = now.getTime() - IN_FLIGHT_WINDOW_MS;
  const s: UsageSnapshot = {
    enabled, dayTokens: 0, monthTokens: 0, dayCostMicros: 0, monthCostMicros: 0,
    clubDayTokens: 0, workflowTokens: 0, agentRunTokens: 0, inFlight: 0,
  };
  for (const r of rows) {
    const t = chargedTokens(r);
    const c = chargedCostMicros(r);
    const at = r.createdAt.getTime();
    if (at >= month.getTime()) { s.monthTokens += t; s.monthCostMicros += c; }
    if (at >= day.getTime()) {
      s.dayTokens += t; s.dayCostMicros += c;
      if (r.clubId === q.clubId) s.clubDayTokens += t;
    }
    if (q.workflowId && r.workflowId === q.workflowId) s.workflowTokens += t;
    if (q.agentRunId && r.agentRunId === q.agentRunId) s.agentRunTokens += t;
    if (r.outcome === 'STARTED' && at >= inFlightSince) s.inFlight += 1;
  }
  return s;
}

/** UTC day and month starts: the windows the platform budgets are counted in. */
export function budgetWindows(now: Date = new Date()): { day: Date; month: Date } {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { day, month };
}

/**
 * How long a reservation holds a concurrency slot. Longer than any call may
 * take (the provider is cut off at its timeout); a reservation older than this
 * stops holding a slot but keeps its full amount in the budgets.
 */
export const IN_FLIGHT_WINDOW_MS = 5 * 60 * 1000;
