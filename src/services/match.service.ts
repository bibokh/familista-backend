import { CompetitionType, MatchResult, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';

export interface CreateMatchDto {
  homeTeam: string;
  awayTeam: string;
  isHome: boolean;
  competition: CompetitionType;
  competitionName?: string;
  venue?: string;
  scheduledAt: string;
}

export interface UpdateMatchDto {
  homeScore?: number;
  awayScore?: number;
  result?: MatchResult;
  playedAt?: string;
  possession?: number;
  shots?: number;
  shotsOnTarget?: number;
  corners?: number;
  fouls?: number;
  yellowCards?: number;
  redCards?: number;
}

export async function getMatches(
  clubId: string,
  filters: { competition?: CompetitionType; page?: number; limit?: number } = {}
) {
  const { competition, page = 1, limit = 20 } = filters;
  const skip = (page - 1) * limit;

  const where: Prisma.MatchWhereInput = {
    clubId,
    ...(competition && { competition }),
  };

  const [matches, total] = await Promise.all([
    prisma.match.findMany({
      where,
      include: {
        playerStats: {
          include: { player: { select: { firstName: true, lastName: true, number: true, position: true } } },
        },
      },
      orderBy: { scheduledAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.match.count({ where }),
  ]);

  return { matches, total, page, limit };
}

export async function getMatchById(id: string, clubId: string) {
  const match = await prisma.match.findUnique({
    where: { id },
    include: {
      playerStats: {
        include: { player: true },
      },
      gpsSession: true,
    },
  });

  if (!match) throw new NotFoundError('Match');
  if (match.clubId !== clubId) throw new ForbiddenError();
  return match;
}

export async function createMatch(clubId: string, dto: CreateMatchDto) {
  return prisma.match.create({
    data: {
      ...dto,
      clubId,
      scheduledAt: new Date(dto.scheduledAt),
    },
  });
}

export async function updateMatch(id: string, clubId: string, dto: UpdateMatchDto) {
  await getMatchById(id, clubId);

  return prisma.match.update({
    where: { id },
    data: {
      ...dto,
      ...(dto.playedAt && { playedAt: new Date(dto.playedAt) }),
    },
  });
}

export async function deleteMatch(id: string, clubId: string): Promise<void> {
  await getMatchById(id, clubId);
  await prisma.match.delete({ where: { id } });
}

export async function getMatchResults(clubId: string) {
  const matches = await prisma.match.findMany({
    where: { clubId, result: { not: null } },
    orderBy: { scheduledAt: 'desc' },
    take: 10,
    select: {
      id: true, homeTeam: true, awayTeam: true,
      homeScore: true, awayScore: true, result: true,
      competition: true, scheduledAt: true,
    },
  });

  const summary = await prisma.match.groupBy({
    by: ['result'],
    where: { clubId, result: { not: null } },
    _count: { id: true },
  });

  return { recentMatches: matches, summary };
}
