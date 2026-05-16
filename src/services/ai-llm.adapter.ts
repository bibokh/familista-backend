// Familista — AI Decision Engine
// File location: src/services/ai-llm.adapter.ts
//
// Claude API adapter for the explainability layer. The deterministic scoring
// engine produces the actual numerical decision; this adapter wraps that with
// a board-safe natural-language rationale. Decisions remain explainable
// without the LLM — `isLlmConfigured()` returns false and the orchestrator
// falls back to a deterministic narrative built from the scored factors.
//
// Features:
//   • Prompt-cached system block (5-minute TTL) to keep per-decision cost low.
//   • Structured JSON output: the model is instructed to emit a strict shape
//     which is parsed and validated. Parse failures degrade to the
//     deterministic narrative — they don't throw into the decision path.
//   • Timeout + retry (one retry on transient errors).
//   • Token-accounting surfaced so AIDecision.llmTokens{In,Out} can be filled.

import type { ScoreFactor, RecommendationAction, Alternative } from '../types/ai-engine.types';

const DEFAULT_MODEL = process.env.AI_LLM_MODEL ?? 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = Number(process.env.AI_LLM_MAX_TOKENS ?? 1024);
const DEFAULT_TIMEOUT_MS = Number(process.env.AI_LLM_TIMEOUT_MS ?? 20_000);

type AnthropicClient = {
  messages: {
    create: (req: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
};

let cachedClient: AnthropicClient | null | undefined;

function getClient(): AnthropicClient | null {
  if (cachedClient !== undefined) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    cachedClient = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@anthropic-ai/sdk') as {
      default?: new (cfg: { apiKey: string }) => AnthropicClient;
      Anthropic?: new (cfg: { apiKey: string }) => AnthropicClient;
    };
    const Ctor = mod.default ?? mod.Anthropic;
    if (!Ctor) {
      cachedClient = null;
      return null;
    }
    cachedClient = new Ctor({ apiKey });
    return cachedClient;
  } catch {
    cachedClient = null;
    return null;
  }
}

export function isLlmConfigured(): boolean {
  return getClient() !== null;
}

export function _resetLlmAdapterForTests(): void {
  cachedClient = undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Narrative request shape (what the scoring engine hands to the LLM)
// ─────────────────────────────────────────────────────────────────────────────

export type NarrativeRequest = {
  domain: string;
  decisionType: string;
  subject: { type: string; id: string; label?: string };
  score: number;
  confidence: number;
  urgency: string;
  features: Record<string, unknown>;
  factors: ScoreFactor[];
  recommendation: RecommendationAction;
  alternatives: Alternative[];
};

export type NarrativeResponse = {
  rationale: string;
  warnings: string[];
  alternatives: Alternative[];
  confidenceDelta: number; // -0.3 to +0.3 — how the LLM nudges deterministic confidence
};

export type LlmUsage = {
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
  model: string;
};

export type NarrativeResult =
  | { ok: true; narrative: NarrativeResponse; usage: LlmUsage }
  | { ok: false; reason: string; usage: LlmUsage };

const SYSTEM_PROMPT_BLOCK = {
  type: 'text',
  text:
    'You are the explainability layer of Familista OS, the board-safe AI for a multi-tenant football SaaS platform.\n' +
    'You receive a deterministic decision (already scored) and must produce a concise, audit-ready rationale.\n' +
    'You DO NOT invent facts beyond the provided features and factors. If a factor is absent, do not speculate.\n' +
    'Tone: precise, neutral, executive-grade. No hype. No emojis. No marketing language.\n' +
    'Output a single JSON object with this exact shape (and nothing else, no prose, no markdown fence):\n' +
    '{\n' +
    '  "rationale": string,            // 2-4 sentences referencing the strongest factors by name\n' +
    '  "warnings": string[],           // 0-3 short caveats grounded in the data\n' +
    '  "alternatives": Array<{ "label": string, "rationale": string, "scoreDelta": number }>,\n' +
    '  "confidenceDelta": number       // between -0.3 and +0.3, +ve if evidence is unusually strong\n' +
    '}',
  cache_control: { type: 'ephemeral' },
} as const;

function buildUserMessage(req: NarrativeRequest): string {
  return JSON.stringify(
    {
      domain: req.domain,
      decisionType: req.decisionType,
      subject: req.subject,
      score: req.score,
      confidence: req.confidence,
      urgency: req.urgency,
      recommendation: req.recommendation,
      topFactors: req.factors.slice(0, 12),
      features: req.features,
      deterministicAlternatives: req.alternatives,
    },
    null,
    2,
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function extractText(blocks: Array<{ type: string; text?: string }>): string {
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
}

function parseNarrative(raw: string): NarrativeResponse | null {
  if (!raw) return null;
  // Strip accidental code fences if the model emits them
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object') return null;
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
    if (!rationale) return null;
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.filter((w: unknown): w is string => typeof w === 'string').slice(0, 5)
      : [];
    type RawAlt = { label: string; rationale: string; scoreDelta?: number };
    const alternatives = Array.isArray(parsed.alternatives)
      ? (parsed.alternatives as unknown[])
          .filter((a: unknown): a is RawAlt =>
            !!a && typeof a === 'object' && typeof (a as { label?: unknown }).label === 'string',
          )
          .slice(0, 5)
          .map((a: RawAlt) => ({
            action: { kind: 'ALTERNATIVE', label: a.label } as RecommendationAction,
            score: typeof a.scoreDelta === 'number' ? a.scoreDelta : 0,
            rationale: typeof a.rationale === 'string' ? a.rationale : '',
          }))
      : [];
    const confidenceDelta = typeof parsed.confidenceDelta === 'number'
      ? clamp(parsed.confidenceDelta, -0.3, 0.3)
      : 0;
    return { rationale, warnings, alternatives, confidenceDelta };
  } catch {
    return null;
  }
}

async function callOnce(req: NarrativeRequest): Promise<NarrativeResult> {
  const started = Date.now();
  const client = getClient();
  if (!client) {
    return {
      ok: false,
      reason: 'LLM_NOT_CONFIGURED',
      usage: { tokensIn: null, tokensOut: null, durationMs: 0, model: DEFAULT_MODEL },
    };
  }

  const userMessage = buildUserMessage(req);

  const completion = client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: DEFAULT_MAX_TOKENS,
    system: [SYSTEM_PROMPT_BLOCK],
    messages: [{ role: 'user', content: userMessage }],
  });

  let response: Awaited<ReturnType<AnthropicClient['messages']['create']>>;
  try {
    response = await Promise.race([
      completion,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('LLM_TIMEOUT')), DEFAULT_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    return {
      ok: false,
      reason: (err as Error).message,
      usage: { tokensIn: null, tokensOut: null, durationMs: Date.now() - started, model: DEFAULT_MODEL },
    };
  }

  const text = extractText(response.content);
  const usage: LlmUsage = {
    tokensIn: response.usage?.input_tokens ?? null,
    tokensOut: response.usage?.output_tokens ?? null,
    durationMs: Date.now() - started,
    model: DEFAULT_MODEL,
  };

  const parsed = parseNarrative(text);
  if (!parsed) return { ok: false, reason: 'LLM_PARSE_FAILED', usage };

  return { ok: true, narrative: parsed, usage };
}

export async function generateNarrative(req: NarrativeRequest): Promise<NarrativeResult> {
  if (!isLlmConfigured()) {
    return {
      ok: false,
      reason: 'LLM_NOT_CONFIGURED',
      usage: { tokensIn: null, tokensOut: null, durationMs: 0, model: DEFAULT_MODEL },
    };
  }

  const first = await callOnce(req);
  if (first.ok) return first;

  // Single retry on transient failure (timeout / parse failure)
  if (first.reason === 'LLM_TIMEOUT' || first.reason === 'LLM_PARSE_FAILED') {
    const retry = await callOnce(req);
    return retry;
  }
  return first;
}
