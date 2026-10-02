// The gateway as the running platform uses it (Cyber Defense, R3)
// ─────────────────────────────────────────────────────────────────────────────
// One provider (Anthropic, through anthropic-provider.ts) and one model id that
// serves the platform's three purposes. Registered on first use, so a test that
// builds its own gateway is never handed the real one.
//
// The model name is AI_LLM_MODEL when set, else the configured default; the
// two direct callers this replaces read those same two places.

import { config } from '../../config';
import { listModels, registerModel, registerProvider } from './gateway';
import { anthropicProvider } from './anthropic-provider';

export const DEFAULT_MODEL_ID = 'familista-default';

/** What the platform asks a model for. A new purpose is a new line here. */
export const AI_PURPOSES = {
  clubAnalysis: 'club-analysis',          // ai.service — ARIA
  decisionNarrative: 'decision-narrative', // ai-llm.adapter — the decision engine's rationale
  agent: 'agent',                          // llm-adapter.service — the agent worker
} as const;

export function ensureDefaultGateway(): void {
  if (listModels().some((m) => m.id === DEFAULT_MODEL_ID)) return;
  registerProvider(anthropicProvider);
  registerModel({
    id: DEFAULT_MODEL_ID,
    provider: 'anthropic',
    providerModel: process.env.AI_LLM_MODEL || config.anthropic.model,
    purposes: Object.values(AI_PURPOSES),
  });
}

/** True when a provider key is configured. Says nothing about whether a call would be allowed. */
export function aiProviderConfigured(): boolean {
  return anthropicProvider.available();
}
