import { prisma } from '../config/database';
import { config } from '../config';
import { NotFoundError, AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { complete, type GatewayResult } from '../platform/intelligence/gateway';
import { AI_PURPOSES, aiProviderConfigured, ensureDefaultGateway } from '../platform/intelligence/default-gateway';
import { clubAiPolicy, type ClubAiPolicy } from '../platform/intelligence/club-ai-policy';
import { isMinor, type DataClass } from '../platform/intelligence/data-classes';

// Cyber Defense, R3: ARIA reaches the model only through the AI Gateway. What
// it sends is built here under the club's policy, and the gateway checks it
// again:
//
//   · every player's name is listed as a subject, so the provider sees [P1],
//     [P2] … and the answer comes back with the names put back;
//   · condition, injury status and diagnosis, and the GPS risk score are
//     RESTRICTED (health data). They are included only when the club has
//     switched restrictedEgress on; otherwise the squad's injury COUNT is all
//     that is said;
//   · a minor's workload and physical data are left out unless the club has
//     allowed RESTRICTED data;
//   · the question a person types is sent as CONFIDENTIAL, with the squad's
//     names replaced in it too.

export type AnalysisType =
  | 'player'
  | 'team'
  | 'match'
  | 'training'
  | 'medical'
  | 'transfer'
  | 'financial';

interface AnalysisRequest {
  type: AnalysisType;
  prompt: string;
  clubId: string;
  userId: string;
  playerId?: string;
  /** Extra classes and names a caller's own prompt carries (analyzePlayer). */
  dataClasses?: DataClass[];
  subjects?: string[];
}

interface SystemContext { system: string; subjects: string[]; dataClasses: DataClass[] }

const MODEL_NAME = () => process.env.AI_LLM_MODEL || config.anthropic.model;

// ── Build system context from live DB data, under the club's policy ───────

export async function buildSystemContext(clubId: string, policy: ClubAiPolicy): Promise<SystemContext> {
  const restricted = policy.restrictedEgress;
  const [club, players, recentMatches, injuries] = await Promise.all([
    prisma.club.findUnique({
      where: { id: clubId },
      select: { name: true, level: true, overallRating: true, leaguePosition: true },
    }),
    prisma.player.findMany({
      where: { clubId },
      select: {
        firstName: true, lastName: true, number: true, dateOfBirth: true,
        position: true, overallRating: true, condition: true,
        isInjured: true,
        gpsData: { orderBy: { recordedAt: 'desc' }, take: 1,
          select: { topSpeed: true, playerLoad: true, riskScore: true } },
      },
      orderBy: { overallRating: 'desc' },
    }),
    prisma.match.findMany({
      where: { clubId },
      orderBy: { scheduledAt: 'desc' },
      take: 5,
      select: { homeTeam: true, awayTeam: true, homeScore: true, awayScore: true, result: true, competition: true },
    }),
    prisma.playerInjury.findMany({
      where: { player: { clubId }, returnedAt: null },
      include: { player: { select: { firstName: true, lastName: true } } },
    }),
  ]);

  const classes = new Set<DataClass>(['PUBLIC', 'INTERNAL']);
  const subjects = players.map((p) => `${p.firstName} ${p.lastName}`);

  const playerSummary = players
    .map((p) => {
      const minor = isMinor(p.dateOfBirth);
      let line = `${p.firstName} ${p.lastName} (#${p.number}, ${p.position}): OVR ${p.overallRating}`;
      if (restricted) {
        line += `, Cond ${p.condition}%${p.isInjured ? ' [INJURED]' : ''}`;
        classes.add('RESTRICTED');
      }
      const gps = p.gpsData[0];
      if (gps && (!minor || restricted)) {
        line += `, GPS: ${gps.topSpeed.toFixed(1)}km/h, Load ${gps.playerLoad.toFixed(0)}`;
        classes.add(minor ? 'RESTRICTED' : 'CONFIDENTIAL');
        if (restricted) line += `, Risk ${gps.riskScore.toFixed(0)}%`;
      }
      return line;
    })
    .join('\n');

  const matchSummary = recentMatches
    .map((m) => `${m.homeTeam} ${m.homeScore ?? '?'}-${m.awayScore ?? '?'} ${m.awayTeam} (${m.result ?? 'TBD'}, ${m.competition})`)
    .join('\n');

  let injurySummary: string;
  if (injuries.length === 0) injurySummary = 'No current injuries';
  else if (restricted) {
    injurySummary = injuries.map((i) => `${i.player.firstName} ${i.player.lastName}: ${i.injuryType} (${i.severity})`).join('\n');
    for (const i of injuries) subjects.push(`${i.player.firstName} ${i.player.lastName}`);
  } else {
    injurySummary = `${injuries.length} player(s) currently injured. Injury details are not shared with the AI provider for this club.`;
  }

  const system = `You are ARIA, the AI Football Analyst for the Familista Sports Intelligence Platform.

CLUB: ${club?.name ?? 'Unknown'} | Level ${club?.level} | OVR ${club?.overallRating} | League Position: ${club?.leaguePosition ?? 'N/A'}

SQUAD (${players.length} players):
${playerSummary}

RECENT RESULTS (last 5):
${matchSummary}

CURRENT INJURIES:
${injurySummary}

INSTRUCTIONS:
- Respond in the same language as the user (Arabic or English)
- Be specific and data-driven; refer to players exactly by the labels given above (for example [P3]) and never invent names
- Keep responses concise (max 4-5 sentences unless a report is requested)
- Provide actionable recommendations
- Format important numbers with proper units`;

  return { system, subjects, dataClasses: [...classes] };
}

/** The status a refusal answers with. */
function refusalStatus(out: GatewayResult): AppError {
  switch (out.refusal) {
    case 'restricted': return new AppError('This analysis needs medical data, which your club has not allowed to be sent to the AI provider', 403);
    case 'budget':     return new AppError('Your club has used today\'s AI allowance. It resets at midnight UTC.', 429);
    case 'provider':   return /rate_limited/.test(out.refusedBecause ?? '')
      ? new AppError('AI rate limit reached, please try again shortly', 429)
      : new AppError('AI service temporarily unavailable', 503);
    case 'invalid-output': return new AppError('AI analysis failed', 502);
    default:           return new AppError('AI service not configured', 503);
  }
}

// ── Main analysis endpoint ────────────────────────────────

export async function analyzeWithAI(req: AnalysisRequest): Promise<{
  response: string;
  tokens: number;
  insightId: string;
}> {
  ensureDefaultGateway();
  if (!aiProviderConfigured()) {
    throw new AppError('AI service not configured', 503);
  }

  const policy = await clubAiPolicy(req.clubId);
  const ctx = await buildSystemContext(req.clubId, policy);

  const out = await complete({
    caller: 'ai.service',
    purpose: AI_PURPOSES.clubAnalysis,
    clubId: req.clubId,
    system: ctx.system,
    prompt: req.prompt,
    dataClasses: [...ctx.dataClasses, 'CONFIDENTIAL', ...(req.dataClasses ?? [])],
    subjects: [...ctx.subjects, ...(req.subjects ?? [])],
    maxOutputTokens: config.anthropic.maxTokens,
  });
  if (!out.ok || out.text === null) {
    logger.warn('AI analysis refused', { type: req.type, refusal: out.refusal ?? null });
    throw refusalStatus(out);
  }

  const text = out.text || 'No response generated';
  const tokens = (out.usage?.inputTokens ?? 0) + (out.usage?.outputTokens ?? 0);

  // Persist insight
  const insight = await prisma.aiInsight.create({
    data: {
      clubId:   req.clubId,
      userId:   req.userId,
      type:     req.type,
      prompt:   req.prompt,
      response: text,
      model:    MODEL_NAME(),
      tokens,
      playerId: req.playerId,
    },
  });

  logger.info('AI analysis completed', { type: req.type, tokens, insightId: insight.id });

  return { response: text, tokens, insightId: insight.id };
}

// ── Get insight history ───────────────────────────────────

export async function getInsightHistory(clubId: string, page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const [insights, total] = await Promise.all([
    prisma.aiInsight.findMany({
      where: { clubId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        user: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.aiInsight.count({ where: { clubId } }),
  ]);
  return { insights, total, page, limit };
}

// ── Player-specific analysis ──────────────────────────────

export async function analyzePlayer(
  playerId: string,
  clubId: string,
  userId: string
) {
  const player = await prisma.player.findFirst({
    where: { id: playerId, clubId },
    include: {
      attributes: { orderBy: { recordedAt: 'desc' }, take: 1 },
      gpsData:    { orderBy: { recordedAt: 'desc' }, take: 5 },
      injuries:   { where: { returnedAt: null } },
    },
  });

  if (!player) throw new NotFoundError('Player');

  const policy = await clubAiPolicy(clubId);
  const name = `${player.firstName} ${player.lastName}`;
  const minor = isMinor(player.dateOfBirth);
  const gps = player.gpsData[0];
  const classes: DataClass[] = ['INTERNAL'];
  const lines = [`Provide a detailed performance analysis for ${name} (${player.position}, #${player.number}).`, `Overall rating: ${player.overallRating}.`];
  if (policy.restrictedEgress) {
    lines.push(`Current condition: ${player.condition}%.`);
    if (player.isInjured) lines.push('CURRENTLY INJURED.');
    classes.push('RESTRICTED');
  }
  if (gps && (!minor || policy.restrictedEgress)) {
    lines.push(`Latest GPS: Top speed ${gps.topSpeed}km/h, Load ${gps.playerLoad}${policy.restrictedEgress ? `, Risk ${gps.riskScore}%` : ''}`);
    classes.push(minor ? 'RESTRICTED' : 'CONFIDENTIAL');
  }
  lines.push('', policy.restrictedEgress
    ? 'Include: strengths, weaknesses, training recommendations, and match readiness assessment.'
    : 'Include: strengths, weaknesses and training recommendations. Medical data is not shared for this club, so do not assess fitness or injury.');
  const prompt = lines.join('\n');

  return analyzeWithAI({ type: 'player', prompt, clubId, userId, playerId, dataClasses: classes, subjects: [name] });
}
