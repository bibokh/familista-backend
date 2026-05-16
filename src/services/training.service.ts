import { DrillType, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';

export interface CreateTrainingDto {
  title: string;
  description?: string;
  scheduledAt: string;
  duration: number;
  drills?: DrillType[];
  playerIds?: string[];
}

export async function getTrainingSessions(
  clubId: string,
  filters: { page?: number; limit?: number } = {}
) {
  const { page = 1, limit = 20 } = filters;
  const skip = (page - 1) * limit;

  const [sessions, total] = await Promise.all([
    prisma.trainingSession.findMany({
      where: { clubId },
      include: {
        playerStats: {
          include: { player: { select: { firstName: true, lastName: true, number: true, position: true } } },
        },
      },
      orderBy: { scheduledAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.trainingSession.count({ where: { clubId } }),
  ]);

  return { sessions, total, page, limit };
}

export async function getTrainingById(id: string, clubId: string) {
  const session = await prisma.trainingSession.findUnique({
    where: { id },
    include: { playerStats: { include: { player: true } } },
  });
  if (!session) throw new NotFoundError('Training session');
  if (session.clubId !== clubId) throw new ForbiddenError();
  return session;
}

export async function createTrainingSession(
  clubId: string,
  dto: CreateTrainingDto
) {
  const { playerIds, ...rest } = dto;

  return prisma.trainingSession.create({
    data: {
      ...rest,
      clubId,
      scheduledAt: new Date(dto.scheduledAt),
      ...(playerIds?.length && {
        playerStats: {
          create: playerIds.map((pid) => ({ playerId: pid })),
        },
      }),
    },
    include: { playerStats: { include: { player: true } } },
  });
}

export async function updateTrainingSession(
  id: string,
  clubId: string,
  dto: Partial<CreateTrainingDto>
) {
  await getTrainingById(id, clubId);
  const { playerIds, ...rest } = dto;

  return prisma.trainingSession.update({
    where: { id },
    data: {
      ...rest,
      ...(dto.scheduledAt && { scheduledAt: new Date(dto.scheduledAt) }),
    },
  });
}

export async function deleteTrainingSession(id: string, clubId: string) {
  await getTrainingById(id, clubId);
  await prisma.trainingSession.delete({ where: { id } });
}

export async function getTrainingForm(clubId: string) {
  const latest = await prisma.trainingSession.findFirst({
    where: { clubId },
    orderBy: { scheduledAt: 'desc' },
    select: {
      attackForm: true,
      defenseForm: true,
      possession: true,
      conditionForm: true,
    },
  });
  return latest ?? { attackForm: 10, defenseForm: 12, possession: 9, conditionForm: 11 };
}
