import { Player, PlayerPosition, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';

export interface CreatePlayerDto {
  firstName: string;
  lastName: string;
  number: number;
  position: PlayerPosition;
  nationality: string;
  flag: string;
  dateOfBirth: string;
  height: number;
  weight: number;
  overallRating?: number;
  potential?: number;
  marketValue?: number;
  weeklyWage?: number;
  contractUntil?: string;
}

export interface UpdatePlayerDto extends Partial<CreatePlayerDto> {
  condition?: number;
  isInjured?: boolean;
}

export interface PlayerFilters {
  position?: PlayerPosition;
  isInjured?: boolean;
  search?: string;
  page?: number;
  limit?: number;
}

// ── Get all players (club-scoped) ─────────────────────────

export async function getPlayers(
  clubId: string,
  filters: PlayerFilters = {}
) {
  const { position, isInjured, search, page = 1, limit = 50 } = filters;
  const skip = (page - 1) * limit;

  const where: Prisma.PlayerWhereInput = {
    clubId,
    ...(position && { position }),
    ...(isInjured !== undefined && { isInjured }),
    ...(search && {
      OR: [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName:  { contains: search, mode: 'insensitive' } },
      ],
    }),
  };

  const [players, total] = await Promise.all([
    prisma.player.findMany({
      where,
      include: {
        attributes: { orderBy: { recordedAt: 'desc' }, take: 1 },
        gpsData:    { orderBy: { recordedAt: 'desc' }, take: 1 },
        injuries:   { where: { returnedAt: null }, orderBy: { injuredAt: 'desc' }, take: 1 },
        device:     { select: { serialNumber: true, isOnline: true, batteryLevel: true } },
      },
      orderBy: { overallRating: 'desc' },
      skip,
      take: limit,
    }),
    prisma.player.count({ where }),
  ]);

  return { players, total, page, limit };
}

// ── Get one player ────────────────────────────────────────

export async function getPlayerById(id: string, clubId: string) {
  const player = await prisma.player.findUnique({
    where: { id },
    include: {
      attributes: { orderBy: { recordedAt: 'desc' }, take: 1 },
      gpsData:    { orderBy: { recordedAt: 'desc' }, take: 10 },
      injuries:   { orderBy: { injuredAt: 'desc' } },
      matchStats: {
        include: { match: { select: { homeTeam: true, awayTeam: true, scheduledAt: true, result: true } } },
        orderBy: { match: { scheduledAt: 'desc' } },
        take: 10,
      },
      device: true,
    },
  });

  if (!player) throw new NotFoundError('Player');
  if (player.clubId !== clubId) throw new ForbiddenError();

  return player;
}

// ── Create player ─────────────────────────────────────────

export async function createPlayer(clubId: string, dto: CreatePlayerDto): Promise<Player> {
  return prisma.player.create({
    data: {
      ...dto,
      clubId,
      dateOfBirth: new Date(dto.dateOfBirth),
      contractUntil: dto.contractUntil ? new Date(dto.contractUntil) : undefined,
    },
  });
}

// ── Update player ─────────────────────────────────────────

export async function updatePlayer(
  id: string,
  clubId: string,
  dto: UpdatePlayerDto
): Promise<Player> {
  await getPlayerById(id, clubId); // ownership check

  return prisma.player.update({
    where: { id },
    data: {
      ...dto,
      ...(dto.dateOfBirth && { dateOfBirth: new Date(dto.dateOfBirth) }),
      ...(dto.contractUntil && { contractUntil: new Date(dto.contractUntil) }),
    },
  });
}

// ── Delete player ─────────────────────────────────────────

export async function deletePlayer(id: string, clubId: string): Promise<void> {
  await getPlayerById(id, clubId);
  await prisma.player.delete({ where: { id } });
}

// ── GPS data ──────────────────────────────────────────────

export async function addGpsData(
  playerId: string,
  clubId: string,
  data: {
    topSpeed: number;
    avgSpeed: number;
    distance: number;
    sprintCount: number;
    heartRateAvg: number;
    heartRateMax: number;
    playerLoad: number;
    riskScore?: number;
    sessionType?: string;
    sessionId?: string;
  }
) {
  await getPlayerById(playerId, clubId);
  return prisma.playerGpsData.create({ data: { playerId, ...data } });
}

// ── Season stats summary ──────────────────────────────────

export async function getPlayerSeasonStats(playerId: string, clubId: string) {
  await getPlayerById(playerId, clubId);

  const stats = await prisma.playerMatchStat.aggregate({
    where: { playerId },
    _sum: { goals: true, assists: true, minutesPlayed: true, shots: true, passes: true, tackles: true },
    _avg: { rating: true, passAccuracy: true },
    _count: { id: true },
  });

  const gps = await prisma.playerGpsData.aggregate({
    where: { playerId },
    _avg: { topSpeed: true, avgSpeed: true, distance: true, heartRateAvg: true, playerLoad: true },
    _max: { topSpeed: true },
  });

  return { matchStats: stats, gpsAverages: gps };
}
