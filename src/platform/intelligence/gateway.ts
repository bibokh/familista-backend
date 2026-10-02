// The AI Gateway — one door, so no product module knows a provider's name
// ─────────────────────────────────────────────────────────────────────────────
// Every AI call in Familista goes:
//
//   product module → AI Gateway → model router → provider
//
// and never product module → provider SDK. That single indirection is what buys
// the platform: a model can be changed for one engine without touching the
// engine, usage and cost can be counted in one place, a jurisdiction can forbid
// a provider without a search-and-replace, and a failing provider can fall back
// without every caller implementing retries.
//
// Cyber Defense, R3: this is no longer a door things "will be moved behind".
// It is the only one. `anthropic-provider.ts` is the only file that imports a
// provider SDK, and every call passes the EGRESS POLICY in `complete()`:
//
//   1. classification  the caller declares the classes of data in the prompt
//                      (data-classes.ts). RESTRICTED — medical details, health
//                      risk, minors' personal data — is refused unless the club
//                      has switched `restrictedEgress` on (club-ai-policy.ts).
//   2. pseudonyms      every name the caller lists as a subject is replaced by
//                      a token ([P1], [P2] …) before anything leaves, and put
//                      back in the answer, so the provider never sees a name
//                      and the reader still does.
//   3. budget          a per-club daily token budget (AI_CLUB_DAILY_TOKEN_BUDGET,
//                      default 200 000), counted from the egress records.
//   4. record          one AiEgressRecord row is written BEFORE the provider is
//                      called (no record, no call) and completed after: caller,
//                      purpose, classes, model, tokens, outcome. Never the
//                      prompt and never the answer.
//   5. untrusted       the answer is data, not instructions: control characters
//                      are stripped, length is capped and, when the caller gives
//                      a schema, it must parse and validate or it is refused.

import type { ZodTypeAny } from 'zod';
import { currentEnvironment } from '../environment';
import { highest, type DataClass } from './data-classes';
import { clubAiPolicy } from './club-ai-policy';

export type ProviderId = 'anthropic' | 'openai' | 'local' | 'none';

export interface ModelDescriptor {
  /** Stable identifier used by engines and recorded in decisions. */
  id: string;
  provider: ProviderId;
  /** The provider's own model name. The only place it appears. */
  providerModel: string;
  /** What this model is allowed to be used for. */
  purposes: string[];
  /** Jurisdictions where this model may NOT be used. Empty means unrestricted. */
  restrictedIn?: string[];
}

export interface GatewayRequest {
  /** The engine or agent asking. Recorded with the usage. */
  caller: string;
  purpose: string;
  prompt: string;
  /** A model may be asked for; the router decides whether it is available. */
  model?: string;
  maxOutputTokens?: number;
  /** The club this call is for, when it is for one. Its policy and budget apply. */
  clubId?: string | null;
  jurisdiction?: string | null;
  /** The system prompt, when the caller has one. Pseudonymised like the prompt. */
  system?: string;
  /**
   * The classes of data the prompt and system prompt carry. Undeclared reads as
   * RESTRICTED: a caller that does not say what it is sending is not trusted
   * with sending it.
   */
  dataClasses?: DataClass[];
  /** Names (people) that must not leave the platform. Replaced by tokens. */
  subjects?: string[];
  timeoutMs?: number;
  /** When given, the answer must be JSON that this schema accepts. */
  outputSchema?: ZodTypeAny;
  /** Longest answer accepted, in characters (default 20 000). */
  maxOutputChars?: number;
}

export interface GatewayResult {
  ok: boolean;
  text: string | null;
  model: string | null;
  provider: ProviderId | null;
  /** Present when ok is false. A reason, never a stack trace. */
  refusedBecause?: string;
  /** Which rule refused it, when one did. */
  refusal?: 'no-model' | 'restricted' | 'budget' | 'audit' | 'provider' | 'invalid-output';
  /** The validated answer, when an output schema was given. */
  data?: unknown;
  /** How many names were replaced before the call. */
  pseudonymised?: number;
  /** The provider's HTTP status when it failed, for categorising. Never its message. */
  providerStatus?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  environment: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  available(): boolean;
  complete(req: GatewayRequest, model: ModelDescriptor): Promise<{ text: string; usage?: GatewayResult['usage'] }>;
}

const providers = new Map<ProviderId, ProviderAdapter>();
const models = new Map<string, ModelDescriptor>();
const usage: Array<{ at: string; caller: string; model: string; provider: ProviderId; clubId: string | null }> = [];

export function registerProvider(adapter: ProviderAdapter): void {
  providers.set(adapter.id, adapter);
}

export function registerModel(descriptor: ModelDescriptor): void {
  models.set(descriptor.id, descriptor);
}

export function listModels(): ModelDescriptor[] {
  return [...models.values()];
}

export function resetGateway(): void {
  providers.clear();
  models.clear();
  usage.length = 0;
  recorder = prismaRecorder;
}

/**
 * Pick the model for a request.
 *
 * A named model wins if it exists, is allowed for the purpose and is not
 * restricted in the caller's jurisdiction. Otherwise the first model that
 * declares the purpose and has an available provider. No model at all is a
 * refusal, not a default: silently falling back to whatever is configured is
 * how a restricted jurisdiction ends up served by a forbidden provider.
 */
export function route(req: GatewayRequest): { model: ModelDescriptor | null; why?: string } {
  const allowed = (m: ModelDescriptor) => {
    if (!m.purposes.includes(req.purpose)) return false;
    if (req.jurisdiction && m.restrictedIn?.includes(req.jurisdiction)) return false;
    return providers.get(m.provider)?.available() ?? false;
  };

  if (req.model) {
    const named = models.get(req.model);
    if (!named) return { model: null, why: `No model is registered as "${req.model}"` };
    if (!named.purposes.includes(req.purpose)) return { model: null, why: `"${req.model}" is not registered for ${req.purpose}` };
    if (req.jurisdiction && named.restrictedIn?.includes(req.jurisdiction)) {
      return { model: null, why: `"${req.model}" may not be used in ${req.jurisdiction}` };
    }
    if (!(providers.get(named.provider)?.available() ?? false)) {
      return { model: null, why: `The provider for "${req.model}" is not configured` };
    }
    return { model: named };
  }

  const candidate = [...models.values()].find(allowed);
  return candidate ? { model: candidate } : { model: null, why: `No configured model serves ${req.purpose}` };
}

// ── egress records ──────────────────────────────────────────────────────────

export interface EgressRecord {
  caller: string; purpose: string; clubId: string | null; model: string | null; provider: string | null;
  dataClasses: DataClass[]; pseudonymised: number;
  outcome: 'STARTED' | 'OK' | 'REFUSED' | 'FAILED' | 'INVALID_OUTPUT';
  reason?: string | null; tokensIn?: number | null; tokensOut?: number | null; durationMs?: number | null;
}

export interface EgressRecorder {
  /** Writes a record; returns its id. Throws when it cannot be written. */
  start(r: EgressRecord): Promise<string>;
  finish(id: string, r: Partial<EgressRecord>): Promise<void>;
  /** Tokens spent today (UTC) for a club, or for platform calls when null. */
  spentToday(clubId: string | null): Promise<number>;
}

const prismaRecorder: EgressRecorder = {
  async start(r) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { prisma } = require('../../config/database') as typeof import('../../config/database');
    const row = await prisma.aiEgressRecord.create({
      data: {
        caller: r.caller, purpose: r.purpose, clubId: r.clubId, model: r.model, provider: r.provider,
        dataClasses: r.dataClasses, pseudonymised: r.pseudonymised, outcome: r.outcome, reason: r.reason ?? null,
      },
      select: { id: true },
    });
    return row.id;
  },
  async finish(id, r) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { prisma } = require('../../config/database') as typeof import('../../config/database');
    await prisma.aiEgressRecord.update({
      where: { id },
      data: {
        outcome: r.outcome, reason: r.reason ?? null,
        tokensIn: r.tokensIn ?? null, tokensOut: r.tokensOut ?? null, durationMs: r.durationMs ?? null,
      },
    });
  },
  async spentToday(clubId) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { prisma } = require('../../config/database') as typeof import('../../config/database');
    const since = new Date(); since.setUTCHours(0, 0, 0, 0);
    const agg = await prisma.aiEgressRecord.aggregate({
      where: { clubId, createdAt: { gte: since } },
      _sum: { tokensIn: true, tokensOut: true },
    });
    return (agg._sum.tokensIn ?? 0) + (agg._sum.tokensOut ?? 0);
  },
};

let recorder: EgressRecorder = prismaRecorder;
/** Tests only: where egress records go. */
export function setEgressRecorder(r: EgressRecorder): void { recorder = r; }

export function dailyTokenBudget(): number {
  const n = Number(process.env.AI_CLUB_DAILY_TOKEN_BUDGET);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200_000;
}

// ── pseudonyms ──────────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bounded = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s)}(?![\\p{L}\\p{N}])`, 'giu');

export interface Pseudonymiser {
  apply(text: string): { text: string; count: number };
  restore(text: string, opts?: { json?: boolean }): string;
}

/**
 * Each distinct name becomes [P1], [P2] …; a single part of a name that belongs
 * to one subject only (a surname on its own) maps to the same token.
 */
export function pseudonymiser(subjects: ReadonlyArray<string> = []): Pseudonymiser {
  const full = [...new Set(subjects.map((n) => n.replace(/\s+/g, ' ').trim()).filter((n) => n.length >= 2))];
  const tokens = new Map<string, string>(); // token -> full name
  const terms: Array<{ term: string; token: string }> = [];
  full.forEach((name, i) => {
    const token = `[P${i + 1}]`;
    tokens.set(token, name);
    terms.push({ term: name, token });
  });
  const partOwners = new Map<string, Set<string>>();
  for (const name of full) {
    for (const part of name.split(' ')) {
      if (part.length < 3) continue;
      const k = part.toLowerCase();
      if (!partOwners.has(k)) partOwners.set(k, new Set());
      partOwners.get(k)!.add(name);
    }
  }
  for (const [part, owners] of partOwners) {
    if (owners.size !== 1) continue;
    const owner = [...owners][0];
    const token = terms.find((t) => t.term === owner)!.token;
    if (!terms.some((t) => t.term.toLowerCase() === part)) terms.push({ term: part, token });
  }
  terms.sort((a, b) => b.term.length - a.term.length);
  const patterns = terms.map((t) => ({ re: bounded(t.term), token: t.token }));
  return {
    apply(text) {
      let count = 0;
      let out = text;
      for (const p of patterns) out = out.replace(p.re, () => { count += 1; return p.token; });
      return { text: out, count };
    },
    restore(text, opts = {}) {
      return text.replace(/\[P(\d+)\]/g, (m) => {
        const name = tokens.get(m);
        if (!name) return m;
        return opts.json ? JSON.stringify(name).slice(1, -1) : name;
      });
    },
  };
}

// ── untrusted output ────────────────────────────────────────────────────────

function untrusted(text: string, maxChars: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, maxChars);
}

function parseJson(text: string): unknown {
  let t = text.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  return JSON.parse(t);
}

/**
 * Ask.
 *
 * Returns a refusal rather than throwing when nothing can serve the request, or
 * when the egress policy says no: a product screen must be able to say "AI is
 * not configured" or "this club does not send medical data" instead of showing
 * an error.
 */
export async function complete(req: GatewayRequest): Promise<GatewayResult> {
  const environment = currentEnvironment();
  const { model, why } = route(req);
  if (!model) {
    return { ok: false, text: null, model: null, provider: null, refusedBecause: why, refusal: 'no-model', environment };
  }
  const started = Date.now();
  const clubId = req.clubId ?? null;
  const dataClasses: DataClass[] = req.dataClasses && req.dataClasses.length ? [...new Set(req.dataClasses)] : ['RESTRICTED'];
  const base: EgressRecord = {
    caller: req.caller, purpose: req.purpose, clubId, model: model.id, provider: model.provider,
    dataClasses, pseudonymised: 0, outcome: 'STARTED',
  };
  const refuse = async (refusal: NonNullable<GatewayResult['refusal']>, reason: string): Promise<GatewayResult> => {
    try { await recorder.start({ ...base, outcome: 'REFUSED', reason: refusal }); } catch { /* the refusal stands either way */ }
    return { ok: false, text: null, model: model.id, provider: model.provider, refusedBecause: reason, refusal, environment };
  };

  // 1 · classification
  if (highest(dataClasses) === 'RESTRICTED' && !(await clubAiPolicy(clubId)).restrictedEgress) {
    return refuse('restricted', 'This request carries restricted data (medical details or minors\' personal data), and the club has not allowed it to be sent to an AI provider');
  }

  // 2 · pseudonyms
  const pseudo = pseudonymiser(req.subjects ?? []);
  const prompt = pseudo.apply(req.prompt);
  const system = req.system !== undefined ? pseudo.apply(req.system) : null;
  const pseudonymised = prompt.count + (system?.count ?? 0);

  // 3 · budget
  let spent: number;
  try { spent = await recorder.spentToday(clubId); } catch { return refuse('audit', 'The AI usage record cannot be read, so nothing is sent'); }
  if (spent >= dailyTokenBudget()) return refuse('budget', 'The daily AI budget for this club is used up');

  // 4 · record, before anything leaves
  let recordId: string;
  try { recordId = await recorder.start({ ...base, pseudonymised }); } catch {
    return { ok: false, text: null, model: model.id, provider: model.provider, refusedBecause: 'The AI call cannot be recorded, so it is not made', refusal: 'audit', environment };
  }
  const finish = (r: Partial<EgressRecord>) => recorder.finish(recordId, { ...r, durationMs: Date.now() - started }).catch(() => undefined);

  const provider = providers.get(model.provider)!;
  const outbound: GatewayRequest = { ...req, prompt: prompt.text, ...(system ? { system: system.text } : {}) };
  let out: { text: string; usage?: GatewayResult['usage'] };
  try {
    out = await provider.complete(outbound, model);
  } catch (err) {
    const category = (err as { category?: string }).category ?? 'failed';
    const status = (err as { status?: unknown }).status;
    await finish({ outcome: 'FAILED', reason: category });
    return {
      ok: false, text: null, model: model.id, provider: model.provider,
      refusedBecause: `The provider failed: ${category}`, refusal: 'provider', environment,
      ...(typeof status === 'number' ? { providerStatus: status } : {}),
    };
  }
  usage.push({ at: new Date().toISOString(), caller: req.caller, model: model.id, provider: model.provider, clubId });
  const tokens = { tokensIn: out.usage?.inputTokens ?? null, tokensOut: out.usage?.outputTokens ?? null };

  // 5 · the answer is untrusted
  const cleaned = untrusted(out.text ?? '', req.maxOutputChars ?? 20_000);
  if (req.outputSchema) {
    let parsed: unknown;
    try { parsed = req.outputSchema.parse(parseJson(pseudo.restore(cleaned, { json: true }))); } catch {
      await finish({ outcome: 'INVALID_OUTPUT', reason: 'schema', ...tokens });
      return {
        ok: false, text: null, model: model.id, provider: model.provider, usage: out.usage,
        refusedBecause: 'The answer did not match the expected shape', refusal: 'invalid-output', pseudonymised, environment,
      };
    }
    await finish({ outcome: 'OK', ...tokens });
    return { ok: true, text: cleaned, data: parsed, model: model.id, provider: model.provider, usage: out.usage, pseudonymised, environment };
  }
  await finish({ outcome: 'OK', ...tokens });
  return { ok: true, text: pseudo.restore(cleaned), model: model.id, provider: model.provider, usage: out.usage, pseudonymised, environment };
}

/** What has been asked of the gateway in this process. Cost attribution's seed. */
export function usageLog(): ReadonlyArray<{ at: string; caller: string; model: string; provider: ProviderId; clubId: string | null }> {
  return usage;
}
