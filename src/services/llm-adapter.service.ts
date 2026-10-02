// Familista — LLM adapter (Phase C)
// ─────────────────────────────────────────────────────────────────────────
// The agent worker's way to a model. Without a provider key it answers with a
// deterministic stub, so the worker can be tested and deployed before keys are
// configured and never crashes the boot path.
//
// Cyber Defense, R3: with a key, the call goes through the AI Gateway and its
// egress policy — the caller declares the classes of data it sends and the
// names that must not leave, RESTRICTED needs the club's permission, and every
// call is recorded. A failure comes back as a category with the provider's
// status, never the provider's message (which routinely quotes the prompt).

import { config } from '../config';
import { logger } from '../utils/logger';
import { complete } from '../platform/intelligence/gateway';
import { AI_PURPOSES, aiProviderConfigured, ensureDefaultGateway } from '../platform/intelligence/default-gateway';
import type { DataClass } from '../platform/intelligence/data-classes';

export interface LLMRequest {
  system?:    string;
  prompt:     string;
  model?:     string;
  maxTokens?: number;
  // Optional, agent-specific structured context. The adapter does NOT
  // interpret this — it is interpolated into the system prompt by the caller.
  context?:   Record<string, unknown>;
  /**
   * Who this invocation is for, for the record only.
   *
   * Purely observational: nothing here reaches the provider, changes the
   * request, or affects what comes back. It exists so the one place every
   * model call passes through can say which piece of work the call belonged
   * to — and so no caller has to publish its own model event and risk
   * publishing the prompt with it.
   */
  observe?: { runId: string; clubId?: string | null; correlationId?: string | null };
  /** The club this call is for. Defaults to observe.clubId. Its policy and budget apply. */
  clubId?: string | null;
  /** What the prompt carries. Undeclared reads as RESTRICTED. */
  dataClasses?: DataClass[];
  /** Names that must not reach the provider. */
  subjects?: string[];
  /** Which part of the platform is asking, for the egress record. */
  caller?: string;
}

export interface LLMResponse {
  text:       string;
  model:      string;
  tokensIn:   number;
  tokensOut:  number;
  costCents:  number;
  backend:    'anthropic' | 'stub';
  startedAt:  Date;
  finishedAt: Date;
}

// Cost guess (USD / 1M tokens, Sonnet-class pricing — recalibrate per model).
const TOKEN_COST = { in: 3, out: 15 }; // dollars per 1M tokens

let _warned = false;

function isAnthropicEnabled(): boolean {
  ensureDefaultGateway();
  const on = aiProviderConfigured();
  if (!on && !_warned) {
    logger.warn('[llm] Anthropic disabled — ANTHROPIC_API_KEY missing. AI agents will use stub responses.');
    _warned = true;
  }
  return on;
}

function stubResponse(req: LLMRequest, started: Date): LLMResponse {
  // Deterministic short response so the agent worker can verify pipeline.
  const text = '[stub] No LLM configured. Echo: ' + req.prompt.slice(0, 200);
  return {
    text,
    model:      'familista-stub-v1',
    tokensIn:   Math.ceil(req.prompt.length / 4),
    tokensOut:  Math.ceil(text.length / 4),
    costCents:  0,
    backend:    'stub',
    startedAt:  started,
    finishedAt: new Date(),
  };
}

export async function llmCall(req: LLMRequest): Promise<LLMResponse> {
  const started = new Date();

  if (!isAnthropicEnabled()) {
    const stub = stubResponse(req, started);
    announce(req, { model: stub.model, provider: stub.backend, tokens: stub.tokensIn + stub.tokensOut });
    return stub;
  }

  // The gateway chooses the model (default-gateway.ts); this is what it uses.
  const model = process.env.AI_LLM_MODEL || config.anthropic.model;
  const out = await complete({
    caller: req.caller ?? 'llm-adapter.service',
    purpose: AI_PURPOSES.agent,
    clubId: req.clubId ?? req.observe?.clubId ?? null,
    system: req.system,
    prompt: req.prompt,
    dataClasses: req.dataClasses,
    subjects: req.subjects,
    maxOutputTokens: req.maxTokens || config.anthropic.maxTokens || 1024,
  });

  if (!out.ok || out.text === null) {
    // The record of a failed invocation is made here, where the call happened,
    // and carries a CATEGORY. The error the caller sees says which rule or
    // which failure — never the provider's own text.
    const err = Object.assign(new Error(`AI call refused: ${out.refusedBecause ?? 'unknown'}`), {
      refusal: out.refusal ?? null,
      ...(typeof out.providerStatus === 'number' ? { status: out.providerStatus } : {}),
    });
    announce(req, { model, provider: 'anthropic', tokens: null, error: err });
    throw err;
  }

  const tokensIn  = out.usage?.inputTokens  ?? Math.ceil(req.prompt.length / 4);
  const tokensOut = out.usage?.outputTokens ?? 0;
  const costCents = Math.round(((tokensIn * TOKEN_COST.in) + (tokensOut * TOKEN_COST.out)) / 1000 * 100 / 1000);
  announce(req, { model, provider: 'anthropic', tokens: tokensIn + tokensOut });

  return {
    text: out.text,
    model,
    tokensIn,
    tokensOut,
    costCents,
    backend:   'anthropic',
    startedAt: started,
    finishedAt: new Date(),
  };
}

/**
 * Tell the fabric a model was called. Never the prompt, never the answer.
 *
 * THE SINGLE FUNNEL for model invocations: every caller in the platform reaches
 * a provider through `llmCall`, so publishing here is what makes it exactly one
 * event per call however many layers sit above it. Silent when the caller did
 * not ask to be observed, and incapable of failing the call either way —
 * `publishFabricEventDetached` does not reject, and this cannot throw.
 */
function announce(
  req: LLMRequest,
  args: { model?: string | null; provider?: string | null; tokens?: number | null; error?: unknown },
): void {
  if (!req.observe?.runId) return;
  try {
    const { publishAIModelInvoked } = require('../fabric/producers/ai.producer') as typeof import('../fabric/producers/ai.producer');
    publishAIModelInvoked(
      {
        runId: req.observe.runId,
        clubId: req.observe.clubId ?? null,
        correlationId: req.observe.correlationId ?? null,
        sourceType: 'AI',
      },
      args,
    );
  } catch (err) {
    logger.warn('[llm] could not record a model invocation', { err: (err as Error)?.message });
  }
}

export function llmStatus(): { backend: 'anthropic' | 'stub'; model: string | null } {
  return {
    backend: aiProviderConfigured() ? 'anthropic' : 'stub',
    model:   config.anthropic?.model ?? null,
  };
}
