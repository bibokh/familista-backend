// Familista — LLM adapter (Phase C)
// ─────────────────────────────────────────────────────────────────────────
// Single facade for every AI agent call. Anthropic is the default backend
// when `ANTHROPIC_API_KEY` is set; otherwise we fall back to a deterministic
// stub so the worker can be tested + deployed before keys are configured.
//
// Why a thin facade and not a fat agent framework: the workers should fail
// SAFELY when keys are missing — never crash the boot path. Every agent
// kind lives in the worker (Phase C), not here.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../utils/logger';

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

// Lazy client — never instantiates on module load.
let _anthropic: Anthropic | null = null;
let _warned = false;

function isAnthropicEnabled(): boolean {
  return !!(config.anthropic && config.anthropic.apiKey);
}

function getAnthropic(): Anthropic | null {
  if (_anthropic) return _anthropic;
  if (!isAnthropicEnabled()) {
    if (!_warned) {
      logger.warn('[llm] Anthropic disabled — ANTHROPIC_API_KEY missing. AI agents will use stub responses.');
      _warned = true;
    }
    return null;
  }
  try {
    _anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
    return _anthropic;
  } catch (err) {
    logger.error('[llm] failed to construct Anthropic client', { err });
    return null;
  }
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
  const client  = getAnthropic();

  if (!client) {
    const stub = stubResponse(req, started);
    announce(req, { model: stub.model, provider: stub.backend, tokens: stub.tokensIn + stub.tokensOut });
    return stub;
  }

  const model = req.model || config.anthropic.model || 'claude-sonnet-4-20250514';
  try {
    const result = await client.messages.create({
      model,
      max_tokens: req.maxTokens || config.anthropic.maxTokens || 1024,
      system:     req.system,
      messages: [{ role: 'user', content: req.prompt }],
    });

    const tokensIn  = result.usage?.input_tokens  ?? Math.ceil(req.prompt.length / 4);
    const tokensOut = result.usage?.output_tokens ?? 0;
    const text = (result.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');

    const costCents = Math.round(((tokensIn * TOKEN_COST.in) + (tokensOut * TOKEN_COST.out)) / 1000 * 100 / 1000);

    announce(req, { model, provider: 'anthropic', tokens: tokensIn + tokensOut });

    return {
      text,
      model,
      tokensIn,
      tokensOut,
      costCents,
      backend:   'anthropic',
      startedAt: started,
      finishedAt: new Date(),
    };
  } catch (err) {
    // The record of a failed invocation is made here, where the call happened,
    // and carries a CATEGORY rather than the provider's message — which
    // routinely quotes the request that caused it, and the request is the
    // prompt. The message itself still bubbles up unchanged.
    announce(req, { model, provider: 'anthropic', tokens: null, error: err });
    // Bubble up — the worker decides what to do.
    throw err;
  }
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
    backend: isAnthropicEnabled() ? 'anthropic' : 'stub',
    model:   config.anthropic?.model ?? null,
  };
}
