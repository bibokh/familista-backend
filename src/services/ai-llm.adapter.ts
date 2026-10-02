// Familista — AI Decision Engine
// File location: src/services/ai-llm.adapter.ts
//
// The explainability layer's narrative. The deterministic scoring engine makes
// the decision; this asks a model for a board-safe rationale around it, and the
// orchestrator falls back to a deterministic narrative whenever the model is
// not configured, refuses, or answers in the wrong shape.
//
// Cyber Defense, R3: it reaches the model only through the AI Gateway.
//   · Features and factors are filtered by class (data-classes.ts): RESTRICTED
//     ones — a player's injuries, condition, health-risk score — are sent only
//     when the club has switched restrictedEgress on. The subject's label is a
//     pseudonym on the way out.
//   · The answer is validated against NARRATIVE_SCHEMA by the gateway; anything
//     else is a refusal and the deterministic narrative is used.

import { z } from 'zod';
import type { ScoreFactor, RecommendationAction, Alternative } from '../types/ai-engine.types';
import { complete } from '../platform/intelligence/gateway';
import { AI_PURPOSES, aiProviderConfigured, ensureDefaultGateway } from '../platform/intelligence/default-gateway';
import { clubAiPolicy } from '../platform/intelligence/club-ai-policy';
import { factorClassOf, filterFeatures, withinCeiling, type DataClass } from '../platform/intelligence/data-classes';

const DEFAULT_MODEL = process.env.AI_LLM_MODEL ?? 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = Number(process.env.AI_LLM_MAX_TOKENS ?? 1024);
const DEFAULT_TIMEOUT_MS = Number(process.env.AI_LLM_TIMEOUT_MS ?? 20_000);

export function isLlmConfigured(): boolean {
  return aiProviderConfigured();
}

/** Kept for existing callers; the gateway holds no per-adapter client any more. */
export function _resetLlmAdapterForTests(): void { /* nothing cached here */ }

// ─────────────────────────────────────────────────────────────────────────────
// Narrative request shape (what the scoring engine hands to the LLM)
// ─────────────────────────────────────────────────────────────────────────────

export type NarrativeRequest = {
  /** The club the decision is for; its AI data policy applies. */
  clubId?: string | null;
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

const SYSTEM_PROMPT =
  'You are the explainability layer of Familista OS, the board-safe AI for a multi-tenant football SaaS platform.\n' +
  'You receive a deterministic decision (already scored) and must produce a concise, audit-ready rationale.\n' +
  'You DO NOT invent facts beyond the provided features and factors. If a factor is absent, do not speculate.\n' +
  'Refer to people only by the labels given (for example [P1]).\n' +
  'Tone: precise, neutral, executive-grade. No hype. No emojis. No marketing language.\n' +
  'Output a single JSON object with this exact shape (and nothing else, no prose, no markdown fence):\n' +
  '{\n' +
  '  "rationale": string,            // 2-4 sentences referencing the strongest factors by name\n' +
  '  "warnings": string[],           // 0-3 short caveats grounded in the data\n' +
  '  "alternatives": Array<{ "label": string, "rationale": string, "scoreDelta": number }>,\n' +
  '  "confidenceDelta": number       // between -0.3 and +0.3, +ve if evidence is unusually strong\n' +
  '}';

/** What the model must answer. Anything else is refused by the gateway. */
export const NARRATIVE_SCHEMA = z.object({
  rationale: z.string().trim().min(1).max(4000),
  warnings: z.array(z.string().max(500)).max(10).default([]),
  alternatives: z.array(z.object({
    label: z.string().min(1).max(200),
    rationale: z.string().max(1000).default(''),
    scoreDelta: z.number().finite().optional(),
  })).max(10).default([]),
  confidenceDelta: z.number().finite().default(0),
});

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** The message, under the club's policy, and the classes it carries. */
export function buildNarrativeMessage(req: NarrativeRequest, ceiling: DataClass): { text: string; classes: DataClass[]; subjects: string[] } {
  const features = filterFeatures(req.features as Record<string, unknown>, ceiling);
  const factors = req.factors.filter((f) => withinCeiling(factorClassOf(f.name), ceiling)).slice(0, 12);
  const classes = new Set<DataClass>(['INTERNAL', ...features.classes, ...factors.map((f) => factorClassOf(f.name))]);
  const label = req.subject.label?.trim();
  const text = JSON.stringify(
    {
      domain: req.domain,
      decisionType: req.decisionType,
      subject: { type: req.subject.type, id: req.subject.id, ...(label ? { label } : {}) },
      score: req.score,
      confidence: req.confidence,
      urgency: req.urgency,
      recommendation: req.recommendation,
      topFactors: factors,
      features: features.features,
      deterministicAlternatives: req.alternatives,
    },
    null,
    2,
  );
  return { text, classes: [...classes], subjects: label ? [label] : [] };
}

async function callOnce(req: NarrativeRequest): Promise<NarrativeResult> {
  const started = Date.now();
  const policy = await clubAiPolicy(req.clubId ?? null);
  const message = buildNarrativeMessage(req, policy.restrictedEgress ? 'RESTRICTED' : 'CONFIDENTIAL');

  const out = await complete({
    caller: 'ai-llm.adapter',
    purpose: AI_PURPOSES.decisionNarrative,
    clubId: req.clubId ?? null,
    system: SYSTEM_PROMPT,
    prompt: message.text,
    dataClasses: message.classes,
    subjects: message.subjects,
    maxOutputTokens: DEFAULT_MAX_TOKENS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    outputSchema: NARRATIVE_SCHEMA,
  });
  const usage: LlmUsage = {
    tokensIn: out.usage?.inputTokens ?? null,
    tokensOut: out.usage?.outputTokens ?? null,
    durationMs: Date.now() - started,
    model: DEFAULT_MODEL,
  };
  if (!out.ok) {
    const reason = out.refusal === 'invalid-output' ? 'LLM_PARSE_FAILED'
      : out.refusal === 'provider' && /timeout/.test(out.refusedBecause ?? '') ? 'LLM_TIMEOUT'
      : out.refusal === 'no-model' ? 'LLM_NOT_CONFIGURED'
      : `LLM_REFUSED_${String(out.refusal ?? 'unknown').toUpperCase().replace(/-/g, '_')}`;
    return { ok: false, reason, usage };
  }
  const parsed = out.data as z.infer<typeof NARRATIVE_SCHEMA>;
  const narrative: NarrativeResponse = {
    rationale: parsed.rationale,
    warnings: parsed.warnings.slice(0, 5),
    alternatives: parsed.alternatives.slice(0, 5).map((a) => ({
      action: { kind: 'ALTERNATIVE', label: a.label } as RecommendationAction,
      score: typeof a.scoreDelta === 'number' ? a.scoreDelta : 0,
      rationale: a.rationale,
    })),
    confidenceDelta: clamp(parsed.confidenceDelta, -0.3, 0.3),
  };
  return { ok: true, narrative, usage };
}

export async function generateNarrative(req: NarrativeRequest): Promise<NarrativeResult> {
  ensureDefaultGateway();
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
    return callOnce(req);
  }
  return first;
}
