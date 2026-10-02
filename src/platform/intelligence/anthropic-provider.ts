// The one file in Familista that talks to Anthropic (Cyber Defense, R3)
// ─────────────────────────────────────────────────────────────────────────────
// Every model call reaches the provider through the AI Gateway
// (`gateway.ts`), and the gateway reaches Anthropic through this adapter and
// nothing else. `ai-single-egress` fails CI when any other file under src/
// imports `@anthropic-ai/sdk`.
//
// What leaves here is what the gateway passed after its egress policy:
// pseudonymised, classified, budgeted and recorded. A failure comes back as a
// CATEGORY — a provider's own error message routinely quotes the request, and
// the request is the prompt.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import { recordOutcome } from '../../infra/outcome-meter';
import type { GatewayRequest, ModelDescriptor, ProviderAdapter } from './gateway';

export class ProviderFailure extends Error {
  constructor(
    public readonly category: 'rate_limited' | 'unavailable' | 'timeout' | 'failed',
    /** The provider's HTTP status, when it gave one. Never its message. */
    public readonly status?: number,
  ) {
    super(`provider ${category}`);
    this.name = 'ProviderFailure';
  }
}

let client: Anthropic | null = null;
let clientKey = '';

function anthropic(): Anthropic | null {
  const key = config.anthropic.apiKey;
  if (!key) return null;
  if (!client || clientKey !== key) { client = new Anthropic({ apiKey: key }); clientKey = key; }
  return client;
}

export const anthropicProvider: ProviderAdapter = {
  id: 'anthropic',
  available: () => !!config.anthropic.apiKey,
  async complete(req: GatewayRequest, model: ModelDescriptor) {
    const c = anthropic();
    if (!c) throw new ProviderFailure('unavailable');
    const timeoutMs = req.timeoutMs ?? 30_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const call = c.messages.create({
        model: model.providerModel,
        max_tokens: req.maxOutputTokens ?? config.anthropic.maxTokens,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content: req.prompt }],
      });
      const res = await Promise.race([
        call,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProviderFailure('timeout')), timeoutMs); }),
      ]);
      recordOutcome('anthropic', true);
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return { text, usage: { inputTokens: res.usage?.input_tokens, outputTokens: res.usage?.output_tokens } };
    } catch (err) {
      recordOutcome('anthropic', false);
      if (err instanceof ProviderFailure) throw err;
      const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : undefined;
      const is = (cls: unknown) => typeof cls === 'function' && err instanceof (cls as new (...a: never[]) => unknown);
      if (is(Anthropic.RateLimitError) || status === 429) throw new ProviderFailure('rate_limited', status ?? 429);
      if (is(Anthropic.APIConnectionError)) throw new ProviderFailure('unavailable', status);
      throw new ProviderFailure('failed', status);
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};
