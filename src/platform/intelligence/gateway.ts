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
// Existing provider integrations keep working: this is the door they will be
// moved behind, not a rewrite of them. Nothing here replaces a working call
// site until that call site is migrated deliberately.

import { currentEnvironment } from '../environment';

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
  /** The club this call is for, when it is for one. Used for cost attribution. */
  clubId?: string | null;
  jurisdiction?: string | null;
}

export interface GatewayResult {
  ok: boolean;
  text: string | null;
  model: string | null;
  provider: ProviderId | null;
  /** Present when ok is false. A reason, never a stack trace. */
  refusedBecause?: string;
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

/**
 * Ask.
 *
 * Returns a refusal rather than throwing when nothing can serve the request:
 * an unconfigured platform is a normal state, and a product screen must be able
 * to say "AI is not configured" instead of showing an error.
 */
export async function complete(req: GatewayRequest): Promise<GatewayResult> {
  const environment = currentEnvironment();
  const { model, why } = route(req);
  if (!model) {
    return { ok: false, text: null, model: null, provider: null, refusedBecause: why, environment };
  }
  const provider = providers.get(model.provider)!;
  try {
    const out = await provider.complete(req, model);
    usage.push({ at: new Date().toISOString(), caller: req.caller, model: model.id, provider: model.provider, clubId: req.clubId ?? null });
    return { ok: true, text: out.text, model: model.id, provider: model.provider, usage: out.usage, environment };
  } catch (err) {
    return {
      ok: false, text: null, model: model.id, provider: model.provider,
      refusedBecause: `The provider failed: ${(err as Error).message}`, environment,
    };
  }
}

/** What has been asked of the gateway in this process. Cost attribution's seed. */
export function usageLog(): ReadonlyArray<{ at: string; caller: string; model: string; provider: ProviderId; clubId: string | null }> {
  return usage;
}
