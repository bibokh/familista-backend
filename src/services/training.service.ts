import { DrillType, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';

export interface CreateTrainingDto {
  title:        string;
  description?: string;
  scheduledAt:  string;
  duration:     number;
  drills?:      DrillType[];
  playerIds?:   string[];
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
          include: {
            player: { select: { id: true, firstName: true, lastName: true, number: true, position: true } },
          },
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
    include: {
      playerStats: {
        include: { player: true },
      },
    },
  });
  if (!session)                    throw new NotFoundError('Training session');
  if (session.clubId !== clubId)   throw new ForbiddenError();
  return session;
}

// Bug fixed: use explicit field mapping instead of ...rest spread so arbitrary
// request body keys cannot reach Prisma.
export async function createTrainingSession(
  clubId: string,
  dto: CreateTrainingDto
) {
  const { playerIds } = dto;

  return prisma.trainingSession.create({
    data: {
      clubId,
      title:       dto.title,
      description: dto.description,
      scheduledAt: new Date(dto.scheduledAt),
      duration:    dto.duration,
      drills:      dto.drills ?? [],
      ...(playerIds?.length && {
        playerStats: {
          create: playerIds.map((pid) => ({ playerId: pid })),
        },
      }),
    },
    include: {
      playerStats: { include: { player: true } },
    },
  });
}

// Bug fixed: playerIds was extracted but silently ignored. Now replaces the
// entire player roster inside a transaction so the operation is atomic.
export async function updateTrainingSession(
  id: string,
  clubId: string,
  dto: Partial<CreateTrainingDto>
) {
  // Ownership check before any write
  await getTrainingById(id, clubId);

  const { playerIds, ...fields } = dto;

  await prisma.$transaction(async (tx) => {
    await tx.trainingSession.update({
      where: { id },
      data: {
        ...(fields.title       !== undefined && { title:       fields.title }),
        ...(fields.description !== undefined && { description: fields.description }),
        ...(fields.scheduledAt !== undefined && { scheduledAt: new Date(fields.scheduledAt) }),
        ...(fields.duration    !== undefined && { duration:    fields.duration }),
        ...(fields.drills      !== undefined && { drills:      fields.drills }),
      },
    });

    // When playerIds provided: atomically replace the roster
    if (playerIds !== undefined) {
      await tx.playerTrainingStat.deleteMany({ where: { sessionId: id } });
      if (playerIds.length > 0) {
        await tx.playerTrainingStat.createMany({
          data: playerIds.map((pid) => ({ sessionId: id, playerId: pid })),
          skipDuplicates: true,
        });
      }
    }
  });

  // Re-fetch to return fresh playerStats relation
  return getTrainingById(id, clubId);
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
      attackForm:    true,
      defenseForm:   true,
      possession:    true,
      conditionForm: true,
    },
  });
  return latest ?? { attackForm: 10, defenseForm: 12, possession: 9, conditionForm: 11 };
}
