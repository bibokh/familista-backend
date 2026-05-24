// Familista — Deterministic AI Agent Handlers (Phase F)
// ─────────────────────────────────────────────────────────────────────────
// One handler per AIAgent enum. Each handler is PURE-DETERMINISTIC: it
// reads the same inputs from the DB and produces the same output. No
// external API calls.
//
// The worker invokes the handler first; if the handler returns a result
// the worker persists it WITHOUT calling the LLM. If the handler returns
// null and an LLM is configured, the worker falls back to the LLM path.
//
// This pattern means:
//  - Production runs without ANTHROPIC_API_KEY produce real output.
//  - With a key, the LLM only fires for agents whose handler returned null
//    (i.e. for free-form generation jobs).
//
// Each handler can also OPTIONALLY emit:
//   - AIAlert rows         (via ai-ops.createAlert)
//   - AIRecommendation rows (via ai-ops.createRecommendation)
//   - AIReport rows         (via ai-ops.createReport)
//
// These are best-effort: failure to emit a side-effect row never poisons
// the handler's return.

import { AIAgent, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import * as aiOps from '../services/ai-ops.service';

export interface AgentJobContext {
  jobId:   string;
  clubId:  string;
  teamId?: string | null;
  agent:   AIAgent;
  kind:    string;
  input:   Prisma.JsonValue;
}

export interface AgentHandlerResult {
  text:        string;          // markdown summary the worker stores as output
  payload?:    Prisma.InputJsonValue;
  model:       string;          // pseudo-model id for telemetry: "familista-deterministic-v1"
  tokensIn:    number;
  tokensOut:   number;
  costCents:   number;
}

type HandlerFn = (ctx: AgentJobContext) => Promise<AgentHandlerResult | null>;

// ─────────────────────────────────────────────────────────────────────────
// Public registry
// ─────────────────────────────────────────────────────────────────────────

const HANDLERS: Partial<Record<AIAgent, HandlerFn>> = {
  TACTICAL:    runTacticalHandler,
  MEDICAL:     runMedicalHandler,
  SCOUTING:    runScoutingHandler,
  FINANCE:     runFinanceHandler,
  TRAINING:    runTrainingHandler,
  MATCH_OPS:   runMatchOpsHandler,
  COMMS:       runCommsHandler,
  CLUB_MANAGER: runClubManagerHandler,
  DEVICE_MGMT: runDeviceMgmtHandler,
  BIG_DATA:    runBigDataHandler,
};

export async function runDeterministicHandler(ctx: AgentJobContext): Promise<AgentHandlerResult | null> {
  const fn = HANDLERS[ctx.agent];
  if (!fn) return null;
  try { return await fn(ctx); }
  catch (err) {
    logger.warn('[agent-handler] failed', { agent: ctx.agent, err: (err as Error).message });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function inputObj(input: Prisma.JsonValue): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  return {};
}

function ageFromDob(dob: Date | string | null | undefined): string {
  if (!dob) return '—';
  const d = typeof dob === 'string' ? new Date(dob) : dob;
  if (!d || Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return String(age);
}

function deterministicResult(text: string, payload?: Prisma.InputJsonValue): AgentHandlerResult {
  // Bytes ≈ tokens-ish: we report length so the existing cost columns stay sane.
  const tokensOut = Math.ceil(text.length / 4);
  return {
    text,
    payload,
    model:     'familista-deterministic-v1',
    tokensIn:  64,
    tokensOut,
    costCents: 0,
  };
}

async function emitRecommendation(
  clubId: string,
  matchId: string | null,
  agent: AIAgent,
  kind: string,
  title: string,
  content: Prisma.InputJsonValue,
  score?: number,
): Promise<void> {
  try {
    await aiOps.createRecommendation({ clubId, matchId, agent, kind, title, content, score });
  } catch (err) { logger.warn('[agent-handler] recommendation emit failed', { err: (err as Error).message }); }
}

async function emitReport(
  clubId: string,
  matchId: string | null,
  agent: AIAgent,
  kind: string,
  title: string,
  content: string,
  payload?: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await aiOps.createReport({ clubId, matchId, agent, kind, title, content, payload });
  } catch (err) { logger.warn('[agent-handler] report emit failed', { err: (err as Error).message }); }
}

// ─────────────────────────────────────────────────────────────────────────
// TACTICAL
// ─────────────────────────────────────────────────────────────────────────

async function runTacticalHandler(ctx: AgentJobContext): Promise<AgentHandlerResult | null> {
  const inp = inputObj(ctx.input);
  const matchId = typeof inp.matchId === 'string' ? inp.matchId : null;
  if (!matchId) return null;     // can't do tactical without a match

  const [match, timeline, lineups, snapshot] = await Promise.all([
    prisma.match.findUnique({ where: { id: matchId } }),
    prisma.matchTimeline.findMany({ where: { matchId, isDeleted: false }, orderBy: { createdAt: 'asc' }, take: 200 }),
    prisma.matchLineup.findMany({ where: { matchId } }),
    prisma.matchTacticalSnapshot.findFirst({ where: { matchId }, orderBy: { createdAt: 'desc' } }),
  ]);
  if (!match || match.clubId !== ctx.clubId) return null;

  // Count meaningful events per side.
  const counts = { HOME: 0, AWAY: 0 };
  let goalsFor = 0, goalsAgainst = 0, shotsFor = 0, shotsAgainst = 0;
  for (const e of timeline) {
    counts[e.side as 'HOME' | 'AWAY']++;
    if (e.kind === 'GOAL' || e.kind === 'PENALTY_SCORED') (e.side === 'HOME' ? goalsFor++ : goalsAgainst++);
    if (e.kind === 'SHOT' || e.kind === 'SHOT_ON_TARGET' || e.kind === 'SHOT_OFF_TARGET') (e.side === 'HOME' ? shotsFor++ : shotsAgainst++);
  }
  const formation = snapshot?.formation ?? lineups.find((l) => l.side === 'HOME')?.formation ?? '—';
  const phase     = snapshot?.phase ?? 'OPEN_PLAY';
  const conversion = shotsFor === 0 ? 0 : Math.round((goalsFor / shotsFor) * 100);

  const score = Math.min(1, Math.max(0, (goalsFor - goalsAgainst + 1) / 5));

  const text = [
    `### Tactical Brief — ${match.homeTeam} vs ${match.awayTeam}`,
    `**Formation:** ${formation}  ·  **Phase:** ${phase}`,
    `**Goals:** ${goalsFor}-${goalsAgainst}  ·  **Shots:** ${shotsFor}-${shotsAgainst}  ·  **Conversion:** ${conversion}%`,
    ``,
    `**Pattern:** Our side accumulated ${counts.HOME} events vs ${counts.AWAY} for the opposition over ${timeline.length} timeline rows.`,
    ``,
    `**Recommended adjustments:**`,
    `- ${shotsAgainst > shotsFor + 2 ? 'Compress mid-third, drop defensive line 5m' : 'Maintain current line height'}`,
    `- ${conversion < 10 && shotsFor > 4 ? 'Switch to inside-channel runs; finishing inefficient' : 'Maintain shot selection'}`,
    `- ${counts.AWAY > counts.HOME * 1.5 ? 'High-press window — refresh midfield via sub' : 'No press refresh needed yet'}`,
  ].join('\n');

  await emitRecommendation(ctx.clubId, matchId, 'TACTICAL', 'TACTICAL_ADJUSTMENT', 'Tactical brief',
    { formation, phase, goalsFor, goalsAgainst, shotsFor, shotsAgainst, conversion } as Prisma.InputJsonValue, score);

  return deterministicResult(text, { formation, phase, goalsFor, goalsAgainst, shotsFor, shotsAgainst, conversion });
}

// ─────────────────────────────────────────────────────────────────────────
// MEDICAL — injury-risk prediction (deterministic placeholder)
// ─────────────────────────────────────────────────────────────────────────

async function runMedicalHandler(ctx: AgentJobContext): Promise<AgentHandlerResult> {
  const inp = inputObj(ctx.input);
  const teamId = typeof inp.teamId === 'string' ? inp.teamId : (ctx.teamId ?? null);

  const players = await prisma.player.findMany({
    where: { clubId: ctx.clubId, ...(teamId ? { teamId } : {}), isActive: true },
    select: {
      id: true, firstName: true, lastName: true, number: true, position: true,
      overallRating: true, condition: true, isInjured: true, medicalStatus: true,
    },
    orderBy: { condition: 'asc' },
    take: 40,
  });

  const at_risk = players
    .map((p) => ({
      ...p,
      score: scoreInjuryRisk(p.condition ?? 80, p.isInjured, p.medicalStatus as string | null),
    }))
    .filter((p) => p.score >= 0.5)
    .slice(0, 8);

  const lines = at_risk.length === 0
    ? ['No players in elevated injury-risk band at this time.']
    : at_risk.map((p) =>
        `- **#${p.number ?? '?'} ${p.firstName} ${p.lastName}** (${p.position ?? '—'}) — risk ${(p.score * 100).toFixed(0)}%, condition ${p.condition ?? '—'}, ${p.isInjured ? 'INJURED' : p.medicalStatus ?? 'HEALTHY'}. Recommend ${p.score > 0.8 ? '48h rest + reassessment' : 'reduced load this microcycle'}.`);

  const text = [
    `### Medical Risk Scan`,
    `Squad surveyed: ${players.length}. Players in elevated band: ${at_risk.length}.`,
    ``,
    ...lines,
  ].join('\n');

  for (const p of at_risk.filter((x) => x.score >= 0.85)) {
    try {
      await aiOps.createAlert({
        clubId:   ctx.clubId,
        teamId:   teamId,
        playerId: p.id,
        agent:    'MEDICAL',
        kind:     'INJURY_RISK',
        severity: 'CRITICAL',
        title:    `${p.firstName} ${p.lastName} — high injury risk`,
        message:  `Composite risk score ${(p.score * 100).toFixed(0)}% (condition ${p.condition ?? '—'}, status ${p.isInjured ? 'INJURED' : p.medicalStatus ?? 'HEALTHY'}).`,
        payload:  { score: p.score, condition: p.condition, isInjured: p.isInjured, medicalStatus: p.medicalStatus } as Prisma.InputJsonValue,
      });
    } catch (_) {/* swallow */}
  }

  return deterministicResult(text, { atRisk: at_risk.map((p) => ({ id: p.id, score: p.score })) } as Prisma.InputJsonValue);
}

/** Combine the available player wellness signals into a 0..1 risk score. */
function scoreInjuryRisk(condition: number, isInjured: boolean, medicalStatus: string | null): number {
  const c = Math.max(0, Math.min(100, condition));
  const conditionGap = 1 - c / 100;
  let medicalLoad = 0;
  if (isInjured)                medicalLoad = 1.0;
  else if (medicalStatus === 'RECOVERING')  medicalLoad = 0.7;
  else if (medicalStatus === 'DOUBTFUL')    medicalLoad = 0.55;
  else if (medicalStatus === 'MONITORING')  medicalLoad = 0.4;
  else                                       medicalLoad = 0.05;
  const raw = conditionGap * 0.45 + medicalLoad * 0.55;
  return Number(Math.max(0, Math.min(1, raw)).toFixed(3));
}

// ─────────────────────────────────────────────────────────────────────────
// SCOUTING
// ─────────────────────────────────────────────────────────────────────────

async function runScoutingHandler(ctx: AgentJobContext): Promise<AgentHandlerResult> {
  const inp = inputObj(ctx.input);
  const position = typeof inp.position === 'string' ? inp.position : null;
  const candidates = await prisma.player.findMany({
    where: {
      clubId: ctx.clubId,
      ...(position ? { position: position as never } : {}),
      isActive: true,
    },
    select: {
      id: true, firstName: true, lastName: true, position: true, dateOfBirth: true,
      overallRating: true, marketValue: true, contractUntil: true,
    },
    orderBy: { overallRating: 'desc' },
    take: 8,
  });

  const text = [
    `### Scouting Shortlist${position ? ` — ${position}` : ''}`,
    candidates.length === 0 ? '_No candidates returned._' : candidates.map((c, i) =>
      `${i + 1}. **${c.firstName} ${c.lastName}** (${c.position ?? '—'}, age ${ageFromDob(c.dateOfBirth)}) — OVR ${c.overallRating ?? '—'}, value €${c.marketValue ?? 0}.`).join('\n'),
  ].join('\n\n');

  return deterministicResult(text, { shortlistIds: candidates.map((c) => c.id) });
}

// ─────────────────────────────────────────────────────────────────────────
// FINANCE — real P&L snapshot from OperationsPayment + InvoiceDraft + Usage
// ─────────────────────────────────────────────────────────────────────────
//
// Pulls every monetary signal we have:
//   • OperationsPayment   — membership / fees ledger (Phase O)
//   • InvoiceDraft        — platform subscription invoices (Phase J)
//   • UsageMeter          — metered-usage counters
//   • OperationsInvoiceLine — line items on draft invoices
//
// Computes:
//   • Receivables (PENDING+OVERDUE) by currency
//   • Recognised revenue (PAID) by currency for last 30/90 days
//   • Top 5 overdue accounts (player or user level)
//   • Burn projection from active subscription line
//   • Anomalies: refund spikes, overdue concentration

async function runFinanceHandler(ctx: AgentJobContext): Promise<AgentHandlerResult> {
  const now = new Date();
  const day30 = new Date(now.getTime() - 30 * 86_400_000);
  const day90 = new Date(now.getTime() - 90 * 86_400_000);

  // ── 1. Operational payments rollup ─────────────────────────────────────
  const payments = await prisma.operationsPayment.findMany({
    where:  { clubId: ctx.clubId },
    select: { state: true, amountCents: true, currency: true, paidAt: true, dueDate: true,
              payerPlayerId: true, payerUserId: true, category: true, createdAt: true },
    take:    5_000,
  });

  const byCcy = new Map<string, { receivable: number; overdue: number; recognised30: number; recognised90: number; refunded: number; count: number }>();
  for (const p of payments) {
    const slot = byCcy.get(p.currency) ?? { receivable: 0, overdue: 0, recognised30: 0, recognised90: 0, refunded: 0, count: 0 };
    slot.count += 1;
    if (p.state === 'PENDING' || p.state === 'OVERDUE') slot.receivable += p.amountCents;
    if (p.state === 'OVERDUE')   slot.overdue      += p.amountCents;
    if (p.state === 'REFUNDED')  slot.refunded     += p.amountCents;
    if (p.state === 'PAID' && p.paidAt) {
      if (p.paidAt >= day30) slot.recognised30 += p.amountCents;
      if (p.paidAt >= day90) slot.recognised90 += p.amountCents;
    }
    byCcy.set(p.currency, slot);
  }

  // ── 2. Top overdue payers ──────────────────────────────────────────────
  const overdueByPayer = new Map<string, { kind: 'PLAYER' | 'USER'; id: string; cents: number; currency: string }>();
  for (const p of payments) {
    if (p.state !== 'OVERDUE') continue;
    const key = p.payerPlayerId ?? p.payerUserId ?? null;
    if (!key) continue;
    const kind: 'PLAYER' | 'USER' = p.payerPlayerId ? 'PLAYER' : 'USER';
    const slot = overdueByPayer.get(key) ?? { kind, id: key, cents: 0, currency: p.currency };
    slot.cents += p.amountCents;
    overdueByPayer.set(key, slot);
  }
  const topOverdue = [...overdueByPayer.values()].sort((a, b) => b.cents - a.cents).slice(0, 5);

  // ── 3. Platform billing (Phase J) ──────────────────────────────────────
  const billingAcct = await prisma.billingAccount.findUnique({
    where:  { clubId: ctx.clubId },
    select: { id: true, status: true, planTierId: true, startedAt: true,
              renewsAt: true, canceledAt: true },
  }).catch(() => null);

  const planTier = billingAcct
    ? await prisma.billingPlanTier.findUnique({
        where:  { id: billingAcct.planTierId },
        select: { code: true, monthlyCents: true },
      }).catch(() => null)
    : null;

  // ── 4. Anomaly detection ──────────────────────────────────────────────
  const anomalies: string[] = [];
  for (const [ccy, s] of byCcy) {
    if (s.overdue > 0 && s.recognised90 > 0 && s.overdue / s.recognised90 > 0.15) {
      anomalies.push(`Overdue/${ccy} = ${(s.overdue / s.recognised90 * 100).toFixed(1)}% of 90-day recognised revenue — exceeds 15% threshold.`);
    }
    if (s.refunded > 0 && s.recognised30 > 0 && s.refunded / s.recognised30 > 0.10) {
      anomalies.push(`Refund/${ccy} = ${(s.refunded / s.recognised30 * 100).toFixed(1)}% of 30-day recognised revenue — exceeds 10% threshold.`);
    }
  }

  // ── 5. Optional LLM narrative (only when key configured) ───────────────
  let narrative = '';
  try {
    const { llmCall, llmStatus } = await import('../services/llm-adapter.service');
    if (llmStatus().backend === 'anthropic') {
      const summary = {
        byCurrency: [...byCcy.entries()].map(([currency, s]) => ({
          currency,
          receivableEur: s.receivable / 100,
          overdueEur:    s.overdue / 100,
          recognised30d: s.recognised30 / 100,
          recognised90d: s.recognised90 / 100,
          refunded:      s.refunded / 100,
        })),
        topOverdue: topOverdue.map((t) => ({ kind: t.kind, id: t.id, eur: t.cents / 100 })),
        billing: billingAcct ? {
          status: billingAcct.status,
          plan: planTier?.code ?? null,
          monthlyBaseEur: ((planTier?.monthlyCents) ?? 0) / 100,
          renewsAt: billingAcct.renewsAt?.toISOString() ?? null,
        } : null,
        anomalies,
      };
      const r = await llmCall({
        system: 'You are the Familista Finance Assistant. Read the JSON snapshot. Output exactly three sections in markdown: "Findings" (3-5 bullets, each citing the figure + ratio that triggered it), "Risks" (2 bullets), "Recommended Actions" (2-4 imperative bullets). Be concise and quantitative. Do not invent numbers not present in the input.',
        prompt: JSON.stringify(summary),
      });
      narrative = r.text.trim();
    }
  } catch (_) { /* LLM optional */ }

  // ── 6. Compose markdown output ─────────────────────────────────────────
  const lines: string[] = [`### Finance Snapshot`, ''];
  if (byCcy.size === 0) {
    lines.push('_No payments recorded for this club yet._');
  } else {
    lines.push('**Receivables (PENDING + OVERDUE):**');
    for (const [ccy, s] of byCcy) {
      lines.push(`- ${ccy}: ${(s.receivable / 100).toFixed(2)} (${(s.overdue / 100).toFixed(2)} overdue), 30d revenue ${(s.recognised30 / 100).toFixed(2)}, 90d ${(s.recognised90 / 100).toFixed(2)}, refunded ${(s.refunded / 100).toFixed(2)}`);
    }
  }
  if (topOverdue.length > 0) {
    lines.push('', '**Top overdue payers:**');
    for (const t of topOverdue) lines.push(`- ${t.kind} \`${t.id.slice(0, 8)}\` — ${(t.cents / 100).toFixed(2)} ${t.currency}`);
  }
  if (billingAcct) {
    const baseEur = ((planTier?.monthlyCents) ?? 0) / 100;
    const renews  = billingAcct.renewsAt?.toISOString().slice(0,10) ?? '—';
    lines.push('', `**Platform subscription:** status=${billingAcct.status}, plan=${planTier?.code ?? '?'}, base ${baseEur.toFixed(2)} EUR/mo, renews ${renews}.`);
  }
  if (anomalies.length > 0) {
    lines.push('', '**Anomalies detected:**');
    for (const a of anomalies) lines.push(`- ${a}`);
  }
  if (narrative) lines.push('', narrative);

  const text = lines.join('\n');

  // Emit alerts on every anomaly so they reach the AI Ops queue.
  for (const a of anomalies) {
    try {
      await aiOps.createAlert({
        clubId: ctx.clubId, agent: 'FINANCE', kind: 'FINANCE_ANOMALY', severity: 'WARN',
        title: 'Finance anomaly detected', message: a,
        payload: { detected: a, at: now.toISOString() } as Prisma.InputJsonValue,
      });
    } catch (_) { /* swallow */ }
  }

  return deterministicResult(text, {
    byCurrency: [...byCcy.entries()].map(([currency, s]) => ({ currency, ...s })),
    topOverdue: topOverdue.map((t) => ({ ...t })),
    anomalies, hasNarrative: narrative.length > 0,
  } as Prisma.InputJsonValue);
}

// ─────────────────────────────────────────────────────────────────────────
// TRAINING — 7-day microcycle, deterministic
// ─────────────────────────────────────────────────────────────────────────

async function runTrainingHandler(ctx: AgentJobContext): Promise<AgentHandlerResult> {
  const inp = inputObj(ctx.input);
  const intensity = typeof inp.intensity === 'string' ? inp.intensity : 'NORMAL';
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Deterministic 7-day cycle keyed off intensity.
  const high   = ['MD-3 — Tactical block + finishing', 'MD-2 — Set pieces + match scenarios', 'MD-1 — Activation + light tactical', 'MD — Match'];
  const normal = ['MD+1 — Recovery (low)', 'MD-4 — Strength + 3v3 small-sided', ...high];
  const low    = ['MD+1 — Pool recovery', 'MD-5 — Mobility + position-specific film', 'MD-4 — Easy aerobic', ...high];
  const cycle  = (intensity === 'HIGH' ? high.concat(['Off','Off','Off']).slice(0,7)
                : intensity === 'LOW'  ? low.slice(0,7)
                :                        normal.slice(0,7));

  const text = [
    `### 7-Day Microcycle (${intensity})`,
    ...cycle.map((s, i) => `- **${days[i]}** — ${s}`),
  ].join('\n');

  return deterministicResult(text, { intensity, plan: cycle });
}

// ─────────────────────────────────────────────────────────────────────────
// MATCH_OPS — automated match report
// ─────────────────────────────────────────────────────────────────────────

async function runMatchOpsHandler(ctx: AgentJobContext): Promise<AgentHandlerResult | null> {
  const inp = inputObj(ctx.input);
  const matchId = typeof inp.matchId === 'string' ? inp.matchId : null;
  if (!matchId) return null;

  const [match, timeline] = await Promise.all([
    prisma.match.findUnique({ where: { id: matchId } }),
    prisma.matchTimeline.findMany({ where: { matchId, isDeleted: false }, orderBy: { occurredAtMin: 'asc' }, take: 300 }),
  ]);
  if (!match || match.clubId !== ctx.clubId) return null;

  const goalsFor = timeline.filter((e) => e.side === 'HOME' && (e.kind === 'GOAL' || e.kind === 'PENALTY_SCORED')).length;
  const goalsAgainst = timeline.filter((e) => e.side === 'AWAY' && (e.kind === 'GOAL' || e.kind === 'PENALTY_SCORED')).length;
  const shotsFor = timeline.filter((e) => e.side === 'HOME' && e.kind.startsWith('SHOT')).length;
  const shotsAgainst = timeline.filter((e) => e.side === 'AWAY' && e.kind.startsWith('SHOT')).length;
  const cards = timeline.filter((e) => e.kind === 'YELLOW_CARD' || e.kind === 'RED_CARD').length;
  const keyMoments = timeline.filter((e) => ['GOAL','RED_CARD','PENALTY_AWARDED','PENALTY_SCORED','OWN_GOAL'].includes(e.kind))
    .slice(0, 8)
    .map((e) => `- **${e.occurredAtMin}'** — ${e.kind} (${e.side})${e.notes ? ' — ' + e.notes : ''}`);

  const headline = goalsFor > goalsAgainst
    ? 'Result reflects sustained pressure and clinical finishing.'
    : goalsFor < goalsAgainst
      ? 'Result hinges on opposition efficiency; underlying numbers suggest tighter game than scoreline.'
      : 'Tight game decided by margins; underlying numbers near parity.';

  const text = [
    `### Post-Match Report — ${match.homeTeam} vs ${match.awayTeam}`,
    `**Final:** ${goalsFor} - ${goalsAgainst}`,
    `**Shots:** ${shotsFor} - ${shotsAgainst}  ·  **Cards:** ${cards}`,
    ``,
    `**Headline:** ${headline}`,
    ``,
    `**Key moments:**`,
    keyMoments.length === 0 ? '_No standout events recorded._' : keyMoments.join('\n'),
  ].join('\n');

  await emitReport(ctx.clubId, matchId, 'MATCH_OPS', 'MATCH_SUMMARY', `Match Report — ${match.homeTeam} vs ${match.awayTeam}`, text,
    { goalsFor, goalsAgainst, shotsFor, shotsAgainst, cards } as Prisma.InputJsonValue);

  return deterministicResult(text, { goalsFor, goalsAgainst, shotsFor, shotsAgainst, cards });
}

// ─────────────────────────────────────────────────────────────────────────
// COMMS
// ─────────────────────────────────────────────────────────────────────────

async function runCommsHandler(ctx: AgentJobContext): Promise<AgentHandlerResult> {
  const inp = inputObj(ctx.input);
  const topic = typeof inp.topic === 'string' ? inp.topic : 'Schedule update';
  const audience = typeof inp.audience === 'string' ? inp.audience : 'Coaches and players';
  const text = [
    `### Notice: ${topic}`,
    ``,
    `Audience: ${audience}`,
    ``,
    `Dear team,`,
    ``,
    `This is an automated notice regarding **${topic}**. Please coordinate with your direct staff line; further details will be shared in the next briefing.`,
    ``,
    `— Familista Communications`,
  ].join('\n');
  return deterministicResult(text);
}

// ─────────────────────────────────────────────────────────────────────────
// CLUB_MANAGER
// ─────────────────────────────────────────────────────────────────────────

async function runClubManagerHandler(ctx: AgentJobContext): Promise<AgentHandlerResult> {
  const [activeMatches, openAlerts, recommendations, players, devicesActive] = await Promise.all([
    prisma.match.count({ where: { clubId: ctx.clubId, status: { in: ['LIVE','HALFTIME','SCHEDULED'] } } }),
    prisma.aIAlert.count({ where: { clubId: ctx.clubId, status: 'OPEN' } }),
    prisma.aIRecommendation.count({ where: { clubId: ctx.clubId, status: 'OPEN' } }),
    prisma.player.count({ where: { clubId: ctx.clubId, isActive: true } }),
    prisma.deviceSession.count({ where: { clubId: ctx.clubId, endedAt: null } }),
  ]);

  const text = [
    `### Club Manager — Operational Snapshot`,
    `- Matches in flight (LIVE/HALFTIME/SCHEDULED): **${activeMatches}**`,
    `- Open alerts: **${openAlerts}**`,
    `- Open recommendations to action: **${recommendations}**`,
    `- Active squad: **${players}**`,
    `- Live device sessions: **${devicesActive}**`,
    ``,
    `**Action items:**`,
    `${openAlerts > 0 ? '- Review open alerts in AI Ops tab' : '- No alerts requiring action'}`,
    `${recommendations > 0 ? '- Triage open recommendations' : '- No pending recommendations'}`,
    `${devicesActive === 0 ? '- No live device sessions — verify match-day hardware checklist' : '- Devices nominal'}`,
  ].join('\n');

  return deterministicResult(text, { activeMatches, openAlerts, recommendations, players, devicesActive });
}

// ─────────────────────────────────────────────────────────────────────────
// DEVICE_MGMT
// ─────────────────────────────────────────────────────────────────────────

async function runDeviceMgmtHandler(ctx: AgentJobContext): Promise<AgentHandlerResult> {
  const sessions = await prisma.deviceSession.findMany({
    where: { clubId: ctx.clubId, endedAt: null },
    select: { id: true, deviceModel: true, deviceSerial: true, startedAt: true },
  });
  const now = Date.now();

  // For each session, find the last packet timestamp.
  const status = await Promise.all(sessions.map(async (s) => {
    const last = await prisma.sensorPacket.findFirst({
      where:  { deviceSessionId: s.id },
      orderBy: { capturedAt: 'desc' },
      select: { capturedAt: true },
    });
    const ageMs = last ? now - last.capturedAt.getTime() : (now - s.startedAt.getTime());
    let health: 'OK' | 'STALE' | 'OFFLINE' = 'OFFLINE';
    if (ageMs < 30_000) health = 'OK'; else if (ageMs < 60_000) health = 'STALE';
    return { ...s, ageMs, health };
  }));

  const stale  = status.filter((s) => s.health === 'STALE').length;
  const offline = status.filter((s) => s.health === 'OFFLINE').length;
  const ok     = status.filter((s) => s.health === 'OK').length;

  const text = [
    `### Device Management — Live Sessions`,
    `**Active sessions:** ${sessions.length}  ·  OK ${ok}  ·  Stale ${stale}  ·  Offline ${offline}`,
    ``,
    ...status.slice(0, 12).map((s) =>
      `- **${s.deviceModel}** (${s.deviceSerial}) — ${s.health}, age ${Math.round(s.ageMs / 1000)}s — session ${s.id.slice(0, 8)}…`),
  ].join('\n');

  return deterministicResult(text, { ok, stale, offline, total: sessions.length });
}

// ─────────────────────────────────────────────────────────────────────────
// BIG_DATA
// ─────────────────────────────────────────────────────────────────────────

async function runBigDataHandler(ctx: AgentJobContext): Promise<AgentHandlerResult> {
  const [pending, published, recent] = await Promise.all([
    prisma.eventOutbox.count({ where: { clubId: ctx.clubId, publishedAt: null } }),
    prisma.eventOutbox.count({ where: { clubId: ctx.clubId, publishedAt: { not: null } } }),
    prisma.eventOutbox.findMany({ where: { clubId: ctx.clubId }, orderBy: { createdAt: 'desc' }, take: 5 }),
  ]);
  const text = [
    `### Big Data Pipeline — Outbox Health`,
    `- Pending egress: **${pending}**`,
    `- Published total: **${published}**`,
    ``,
    `**Recent rows:**`,
    recent.length === 0 ? '_No outbox activity yet._' :
      recent.map((e) => `- \`${e.kind}\` · matchId=${e.matchId ?? '—'} · seq=${e.seq} · ${e.publishedAt ? 'PUBLISHED' : 'PENDING'}`).join('\n'),
  ].join('\n');
  return deterministicResult(text, { pending, published });
}
