// Familista — AI Agent worker (Phase C)
// ─────────────────────────────────────────────────────────────────────────
// Polling worker that drains AIAgentJob rows in PENDING status.
//
// Per tick:
//   1. Pick one PENDING job (oldest first), mark RUNNING in a CAS-style
//      update guarded by `where: { status: PENDING }` so two workers can
//      coexist safely (we ship single-instance for Phase C but the lock
//      is correct either way).
//   2. Build the system prompt by agent kind.
//   3. Call llmCall(...).
//   4. Persist output + status + cost.
//
// Lives in-process inside the API container — fine for Phase C. Phase D
// can lift this into a dedicated worker dyno without code change because
// the table is the only contract.

import { AIAgent, AutomationStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { llmCall, llmStatus } from '../services/llm-adapter.service';
import { runDeterministicHandler } from './agent-handlers';
import { classifyRisk, getJobApproval, requestApproval } from '../security/ai-approval.service';
import { logSecurityEvent } from '../security/security-event.service';
import { recordDecision, impactFor } from '../services/ai-agent-decision.service';

const TICK_MS = 4_000;
const STALE_RUNNING_MS = 10 * 60 * 1000;   // a job running > 10 min is considered stalled

let _running = false;
let _timer:   ReturnType<typeof setTimeout> | null = null;

// ─────────────────────────────────────────────────────────────────────────
// Per-agent system prompts — short, opinionated, deterministic ordering.
// Worker passes job.input verbatim as the user prompt; agent decides shape.
// ─────────────────────────────────────────────────────────────────────────
const SYSTEM_BY_AGENT: Record<AIAgent, string> = {
  CLUB_MANAGER:
    'You are the Familista Club Manager agent. Summarise operational state, surface bottlenecks, and produce ranked action items. Be concise; use markdown headings + bullets.',
  TACTICAL:
    'You are the Familista Tactical Assistant. Analyse match feature bundles (timeline, lineups, snapshots, formations) and produce: 1) opponent profile, 2) our pattern, 3) recommended adjustments with risk score 0-1. Markdown only.',
  MEDICAL:
    'You are the Familista Medical Assistant. From workload + injury history + GPS aggregates, output ranked injury-risk list with reasoning + suggested recovery window. Never give clinical diagnoses.',
  SCOUTING:
    'You are the Familista Scouting Assistant. Compare prospects on attributes, age, position, market value; output a ranked shortlist with concrete next-step recommendations.',
  FINANCE:
    'You are the Familista Finance Assistant. From financial rows, surface anomalies and recommend cost-saving actions. Always quote the figure + ratio that triggered each finding.',
  TRAINING:
    'You are the Familista Training Assistant. Generate a 7-day microcycle adapted to the squad fitness state + upcoming match calendar.',
  MATCH_OPS:
    'You are the Familista Match Operations agent. From a match feature bundle, write a post-match report (key moments, xG-style estimate, individual ratings, headline insight).',
  COMMS:
    'You are the Familista Communications agent. Draft notices for coaches/players/parents from a structured brief. Tone: professional, short, multilingual when locale is provided.',
  DEVICE_MGMT:
    'You are the Familista Device Management agent. Detect anomalies in device sessions and sensor diagnostics. Output: device → status → recommended remediation.',
  BIG_DATA:
    'You are the Familista Big Data Agent. Summarise streaming pipeline health and surface drift / latency / volume issues across the cluster.',
};

function pickSystemPrompt(agent: AIAgent, kind: string): string {
  const base = SYSTEM_BY_AGENT[agent] || 'You are a Familista AI agent.';
  return base + `\n\nJob kind: ${kind}`;
}

// ─────────────────────────────────────────────────────────────────────────
// One tick
// ─────────────────────────────────────────────────────────────────────────

async function pickOneJob(): Promise<{ id: string; agent: AIAgent; kind: string; input: Prisma.JsonValue; clubId: string } | null> {
  // Atomic claim — single SQL update guarded by status=PENDING.
  // We avoid Prisma's findFirst+update race by issuing one updateMany then re-reading.
  const candidate = await prisma.aIAgentJob.findFirst({
    where:   { status: AutomationStatus.PENDING },
    orderBy: { createdAt: 'asc' },
    select:  { id: true },
  });
  if (!candidate) return null;

  const claimed = await prisma.aIAgentJob.updateMany({
    where: { id: candidate.id, status: AutomationStatus.PENDING },
    data:  { status: AutomationStatus.RUNNING, startedAt: new Date() },
  });
  if (claimed.count === 0) return null;       // someone else got it

  const j = await prisma.aIAgentJob.findUnique({ where: { id: candidate.id } });
  if (!j) return null;
  return { id: j.id, agent: j.agent, kind: j.kind, input: j.input, clubId: j.clubId };
}

async function reapStalled(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS);
  await prisma.aIAgentJob.updateMany({
    where: { status: AutomationStatus.RUNNING, startedAt: { lt: cutoff } },
    data:  { status: AutomationStatus.FAILED, finishedAt: new Date(), error: 'Stalled — exceeded max running window' },
  });
}

async function runOne(job: { id: string; agent: AIAgent; kind: string; input: Prisma.JsonValue; clubId: string }): Promise<void> {
  try {
    // Phase I — high-risk approval gate. Classify the job; if risky,
    // ensure there's an APPROVED approval row before continuing. If the
    // approval is missing or still pending, park the job (revert to
    // PENDING) so it gets re-picked after a human acts.
    const riskKind = classifyRisk(job.kind, job.input);
    if (riskKind) {
      const existing = await getJobApproval(job.id);
      if (!existing) {
        // No approval row yet — create one and park the job.
        const requesterId = (() => {
          const t = (job.input as { triggeredBy?: string } | null);
          return (t && typeof t.triggeredBy === 'string') ? t.triggeredBy : 'system';
        })();
        try {
          await requestApproval(
            { userId: requesterId, clubId: job.clubId, ipAddress: null, userAgent: null },
            { agent: job.agent, kind: riskKind, payload: { input: job.input } as Prisma.InputJsonValue, jobId: job.id },
          );
        } catch (err) {
          logger.warn('[ai-worker] approval requestApproval failed', { id: job.id, err: (err as Error).message });
        }
        logSecurityEvent({ kind: 'APPROVAL_REQUESTED', severity: 'WARN', clubId: job.clubId, payload: { jobId: job.id, riskKind } });
        await prisma.aIAgentJob.update({ where: { id: job.id }, data: { status: AutomationStatus.PENDING, startedAt: null } });
        return;
      }
      if (existing.status === 'PENDING') {
        // Park.
        await prisma.aIAgentJob.update({ where: { id: job.id }, data: { status: AutomationStatus.PENDING, startedAt: null } });
        return;
      }
      if (existing.status === 'REJECTED' || existing.status === 'EXPIRED') {
        await prisma.aIAgentJob.update({
          where: { id: job.id },
          data:  {
            status:     AutomationStatus.FAILED,
            finishedAt: new Date(),
            error:      `Approval ${existing.status.toLowerCase()}: ${existing.rejectedReason ?? ''}`.slice(0, 4000),
          },
        });
        return;
      }
      // APPROVED — mark approval row as EXECUTED after success below.
    }

    // Phase F — deterministic handler runs FIRST. If it returns a result,
    // we skip the LLM entirely. This keeps production working with no
    // external API key configured (the user's constraint #5).
    const deterministic = await runDeterministicHandler({
      jobId:  job.id,
      clubId: job.clubId,
      agent:  job.agent,
      kind:   job.kind,
      input:  job.input,
    });
    if (deterministic) {
      await prisma.aIAgentJob.update({
        where: { id: job.id },
        data: {
          status:     AutomationStatus.SUCCESS,
          finishedAt: new Date(),
          output:     { text: deterministic.text, payload: deterministic.payload, model: deterministic.model, backend: 'deterministic' } as Prisma.InputJsonValue,
          model:      deterministic.model,
          costTokens: deterministic.tokensIn + deterministic.tokensOut,
          costCents:  deterministic.costCents,
        },
      });
      logger.info('[ai-worker] deterministic job done', { id: job.id, agent: job.agent });
      // Phase J — record the decision (rationale + telemetry + impact) and
      // anchor it in the audit chain.
      try {
        const matchId = (typeof (job.input as { matchId?: unknown })?.matchId === 'string') ? (job.input as { matchId: string }).matchId : null;
        await recordDecision({
          clubId:           job.clubId,
          matchId,
          agent:            job.agent,
          kind:             job.kind,
          jobId:            job.id,
          rationale:        deterministic.text.slice(0, 4000),
          sourceTelemetry:  { input: job.input } as Prisma.InputJsonValue,
          confidence:       0.85,    // deterministic handlers are high-confidence by design
          tacticalImpact:   impactFor(0.85, job.kind),
          payload:          deterministic.payload ?? null,
          modelVersion:     'familista-deterministic-v1',
          backend:          'deterministic',
        });
      } catch (err) {
        logger.warn('[ai-worker] decision record failed', { id: job.id, err: (err as Error).message });
      }
      await markApprovalExecutedIfAny(job.id);
      return;
    }

    const prompt = typeof job.input === 'string'
      ? job.input
      : JSON.stringify(job.input ?? {}, null, 2);
    const system = pickSystemPrompt(job.agent, job.kind);

    const result = await llmCall({ system, prompt, maxTokens: 1024 });

    await prisma.aIAgentJob.update({
      where: { id: job.id },
      data: {
        status:     AutomationStatus.SUCCESS,
        finishedAt: new Date(),
        output:     { text: result.text, model: result.model, backend: result.backend } as Prisma.InputJsonValue,
        model:      result.model,
        costTokens: result.tokensIn + result.tokensOut,
        costCents:  result.costCents,
      },
    });
    logger.info('[ai-worker] llm job done', { id: job.id, agent: job.agent, tokens: result.tokensIn + result.tokensOut, cents: result.costCents });
    // Phase J — record LLM decision (slightly lower default confidence).
    try {
      const matchId = (typeof (job.input as { matchId?: unknown })?.matchId === 'string') ? (job.input as { matchId: string }).matchId : null;
      await recordDecision({
        clubId:           job.clubId,
        matchId,
        agent:            job.agent,
        kind:             job.kind,
        jobId:            job.id,
        rationale:        result.text.slice(0, 4000),
        sourceTelemetry:  { input: job.input } as Prisma.InputJsonValue,
        confidence:       0.65,
        tacticalImpact:   impactFor(0.65, job.kind),
        payload:          null,
        modelVersion:     result.model,
        backend:          'llm',
      });
    } catch (err) {
      logger.warn('[ai-worker] decision record (llm) failed', { id: job.id, err: (err as Error).message });
    }
    await markApprovalExecutedIfAny(job.id);
  } catch (err) {
    await prisma.aIAgentJob.update({
      where: { id: job.id },
      data: {
        status:     AutomationStatus.FAILED,
        finishedAt: new Date(),
        error:      (err as Error)?.message?.slice(0, 4000) ?? 'unknown error',
      },
    });
    logger.warn('[ai-worker] job failed', { id: job.id, err: (err as Error)?.message });
  }
}

/** Phase I — flip any approval gating this job to EXECUTED. Best-effort. */
async function markApprovalExecutedIfAny(jobId: string): Promise<void> {
  try {
    await prisma.aIApprovalRequest.updateMany({
      where: { jobId, status: 'APPROVED' },
      data:  { status: 'EXECUTED' },
    });
  } catch (err) {
    logger.warn('[ai-worker] markApprovalExecuted failed', { jobId, err: (err as Error).message });
  }
}

async function tick(): Promise<void> {
  if (!_running) return;
  try {
    await reapStalled();
    let processed = 0;
    // Drain up to 5 jobs per tick before yielding back to the timer.
    for (let i = 0; i < 5; i++) {
      const j = await pickOneJob();
      if (!j) break;
      await runOne(j);
      processed++;
    }
    if (processed > 0) logger.info('[ai-worker] tick', { processed });
  } catch (err) {
    logger.error('[ai-worker] tick error', { err: (err as Error)?.message });
  } finally {
    if (_running) _timer = setTimeout(tick, TICK_MS);
  }
}

export function startAIAgentWorker(): void {
  if (_running) return;
  _running = true;
  const status = llmStatus();
  logger.info('[ai-worker] starting', { tickMs: TICK_MS, backend: status.backend });
  _timer = setTimeout(tick, TICK_MS);
}

export async function stopAIAgentWorker(): Promise<void> {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  logger.info('[ai-worker] stopped');
}
