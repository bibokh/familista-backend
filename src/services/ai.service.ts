import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../config/database';
import { config } from '../config';
import { NotFoundError, AppError } from '../utils/errors';
import { logger } from '../utils/logger';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

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
}

// ── Build system context from live DB data ────────────────

async function buildSystemContext(clubId: string): Promise<string> {
  const [club, players, recentMatches, injuries] = await Promise.all([
    prisma.club.findUnique({
      where: { id: clubId },
      select: { name: true, level: true, overallRating: true, leaguePosition: true },
    }),
    prisma.player.findMany({
      where: { clubId },
      select: {
        firstName: true, lastName: true, number: true,
        position: true, overallRating: true, condition: true,
        isInjured: true,
        gpsData: { orderBy: { recordedAt: 'desc' }, take: 1,
          select: { topSpeed: true, playerLoad: true, riskScore: true, heartRateAvg: true } },
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

  const playerSummary = players
    .map(
      (p) =>
        `${p.firstName} ${p.lastName} (#${p.number}, ${p.position}): OVR ${p.overallRating}, Cond ${p.condition}%${p.isInjured ? ' [INJURED]' : ''}${
          p.gpsData[0]
            ? `, GPS: ${p.gpsData[0].topSpeed.toFixed(1)}km/h, Load ${p.gpsData[0].playerLoad.toFixed(0)}, Risk ${p.gpsData[0].riskScore.toFixed(0)}%`
            : ''
        }`
    )
    .join('\n');

  const matchSummary = recentMatches
    .map((m) => `${m.homeTeam} ${m.homeScore ?? '?'}-${m.awayScore ?? '?'} ${m.awayTeam} (${m.result ?? 'TBD'}, ${m.competition})`)
    .join('\n');

  const injurySummary =
    injuries.length > 0
      ? injuries.map((i) => `${i.player.firstName} ${i.player.lastName}: ${i.injuryType} (${i.severity})`).join('\n')
      : 'No current injuries';

  return `You are ARIA, the AI Football Analyst for the Familista Sports Intelligence Platform.

CLUB: ${club?.name ?? 'Unknown'} | Level ${club?.level} | OVR ${club?.overallRating} | League Position: ${club?.leaguePosition ?? 'N/A'}

SQUAD (${players.length} players):
${playerSummary}

RECENT RESULTS (last 5):
${matchSummary}

CURRENT INJURIES:
${injurySummary}

INSTRUCTIONS:
- Respond in the same language as the user (Arabic or English)
- Be specific and data-driven, reference real player names and stats
- Keep responses concise (max 4-5 sentences unless a report is requested)
- Provide actionable recommendations
- Format important numbers with proper units`;
}

// ── Main analysis endpoint ────────────────────────────────

export async function analyzeWithAI(req: AnalysisRequest): Promise<{
  response: string;
  tokens: number;
  insightId: string;
}> {
  if (!config.anthropic.apiKey) {
    throw new AppError('AI service not configured', 503);
  }

  // Build context
  const systemPrompt = await buildSystemContext(req.clubId);

  // Call Claude
  let response: Anthropic.Message;
  try {
    response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: req.prompt }],
    });
  } catch (err: unknown) {
    if (err instanceof Anthropic.RateLimitError) {
      throw new AppError('AI rate limit reached, please try again shortly', 429);
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw new AppError('AI service temporarily unavailable', 503);
    }
    logger.error('Anthropic API error', { err });
    throw new AppError('AI analysis failed', 500);
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : 'No response generated';
  const tokens = response.usage.input_tokens + response.usage.output_tokens;

  // Persist insight
  const insight = await prisma.aiInsight.create({
    data: {
      clubId:   req.clubId,
      userId:   req.userId,
      type:     req.type,
      prompt:   req.prompt,
      response: text,
      model:    config.anthropic.model,
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

  const prompt = `Provide a detailed performance analysis for ${player.firstName} ${player.lastName} (${player.position}, #${player.number}).
Current condition: ${player.condition}%. Overall rating: ${player.overallRating}.
${player.isInjured ? 'CURRENTLY INJURED.' : ''}
${player.gpsData[0] ? `Latest GPS: Top speed ${player.gpsData[0].topSpeed}km/h, Load ${player.gpsData[0].playerLoad}, Risk ${player.gpsData[0].riskScore}%` : ''}

Include: strengths, weaknesses, training recommendations, and match readiness assessment.`;

  return analyzeWithAI({ type: 'player', prompt, clubId, userId, playerId });
}
