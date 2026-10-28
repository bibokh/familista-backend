// The owner's AI cost view — what the execution gate allows, and what it has counted
// ─────────────────────────────────────────────────────────────────────────────
// Read by the AI Agents Operations Room (GET /system/agents/cost), the Platform
// Owner's alone. Everything here is platform-wide and grouped by model, agent
// or rule: no club, person, prompt or answer appears, and a provider key is
// reported only as present or absent, never as a value.
//
// Every amount is labelled for what it is. "Charged" is what the budgets count
// (reported usage, and whole reservations where none was reported); "reported"
// is the provider's own count of its responses; costs are ESTIMATES from the
// configured prices. None of it is the provider's invoice.

import { aiProviderConfigured, ensureDefaultGateway } from './default-gateway';
import { listModels } from './gateway';
import { killSwitchEngaged, killSwitchReason } from './agents';
import { AUTONOMOUS_AI_EXECUTION, BUDGET_LIMIT_REFUSALS, aiPolicyConfig } from './execution-gate';
import { readExecutionControl, usageReport, type UsageReport, type UsageWindow } from './ai-ledger';

const usd = (micros: number) => Math.round(micros) / 1_000_000;

export interface CostWindowView {
  chargedTokens: number;
  reportedTokensIn: number;
  reportedTokensOut: number;
  estimatedCostUsd: number;
  reportedEstimatedCostUsd: number;
  calls: number;
  refused: number;
}

export interface AiCostRoomView {
  /** Every cost below is an estimate from configured prices, never provider billing. */
  basis: 'estimate';
  execution: { enabled: boolean; reason: string | null; changedAt: string | null; readable: boolean };
  killSwitch: { engaged: boolean; reason: string | null };
  autonomous: false;
  /** Whether a provider key is configured. Its value never leaves the server. */
  providerConfigured: boolean;
  limits: {
    perRequestTokens: number; perWorkflowTokens: number; perAgentRunTokens: number; clubDailyTokens: number;
    dailyTokens: number; monthlyTokens: number; dailyCostUsd: number; monthlyCostUsd: number; maxConcurrent: number;
  };
  /** The names of settings that are set but invalid. While any is listed, every call is refused. */
  configErrors: string[];
  models: Array<{ id: string; providerModel: string; priced: boolean; inputPerMTokUsd: number | null; outputPerMTokUsd: number | null }>;
  usage: null | {
    day: CostWindowView;
    month: CostWindowView;
    remaining: { dayTokens: number; monthTokens: number; dayCostUsd: number; monthCostUsd: number };
    inFlight: number;
    byModel: Array<{ model: string; calls: number; tokensIn: number; tokensOut: number; estimatedCostUsd: number }>;
    byAgent: Array<{ agent: string; calls: number; tokens: number; estimatedCostUsd: number }>;
    refusals: UsageReport['refusals'];
    budgetEvents: UsageReport['budgetEvents'];
    overruns: number;
  };
  /** Why `usage` is null, when it is. */
  unavailable?: string;
}

function windowView(w: UsageWindow): CostWindowView {
  return {
    chargedTokens: w.chargedTokens, reportedTokensIn: w.reportedTokensIn, reportedTokensOut: w.reportedTokensOut,
    estimatedCostUsd: usd(w.chargedCostMicros), reportedEstimatedCostUsd: usd(w.reportedCostMicros),
    calls: w.calls, refused: w.refused,
  };
}

export async function aiCostRoomView(now: Date = new Date()): Promise<AiCostRoomView> {
  ensureDefaultGateway();
  const policy = aiPolicyConfig();
  const l = policy.limits;

  let execution: AiCostRoomView['execution'] = { enabled: false, reason: null, changedAt: null, readable: false };
  try { execution = { ...(await readExecutionControl()), readable: true }; } catch { /* unreadable reads as OFF */ }

  let usage: AiCostRoomView['usage'] = null;
  let unavailable: string | undefined;
  try {
    const r = await usageReport(BUDGET_LIMIT_REFUSALS, now);
    usage = {
      day: windowView(r.day),
      month: windowView(r.month),
      remaining: {
        dayTokens: Math.max(0, l.dailyTokens - r.day.chargedTokens),
        monthTokens: Math.max(0, l.monthlyTokens - r.month.chargedTokens),
        dayCostUsd: usd(Math.max(0, l.dailyCostMicros - r.day.chargedCostMicros)),
        monthCostUsd: usd(Math.max(0, l.monthlyCostMicros - r.month.chargedCostMicros)),
      },
      inFlight: r.inFlight,
      byModel: r.byModel.map((m) => ({ model: m.model, calls: m.calls, tokensIn: m.tokensIn, tokensOut: m.tokensOut, estimatedCostUsd: usd(m.costMicros) })),
      byAgent: r.byAgent.map((a) => ({ agent: a.agent, calls: a.calls, tokens: a.tokens, estimatedCostUsd: usd(a.costMicros) })),
      refusals: r.refusals,
      budgetEvents: r.budgetEvents,
      overruns: r.overruns,
    };
  } catch {
    unavailable = 'The AI usage record is not readable in this deployment.';
  }

  return {
    basis: 'estimate',
    execution,
    killSwitch: { engaged: killSwitchEngaged(), reason: killSwitchReason() },
    autonomous: AUTONOMOUS_AI_EXECUTION,
    providerConfigured: aiProviderConfigured(),
    limits: {
      perRequestTokens: l.perRequestTokens, perWorkflowTokens: l.perWorkflowTokens, perAgentRunTokens: l.perAgentRunTokens,
      clubDailyTokens: l.clubDailyTokens, dailyTokens: l.dailyTokens, monthlyTokens: l.monthlyTokens,
      dailyCostUsd: usd(l.dailyCostMicros), monthlyCostUsd: usd(l.monthlyCostMicros), maxConcurrent: l.maxConcurrent,
    },
    configErrors: policy.errors,
    models: listModels().map((m) => {
      const p = policy.pricing[m.providerModel];
      return { id: m.id, providerModel: m.providerModel, priced: !!p, inputPerMTokUsd: p?.inputPerMTokUsd ?? null, outputPerMTokUsd: p?.outputPerMTokUsd ?? null };
    }),
    usage,
    ...(unavailable ? { unavailable } : {}),
  };
}
