import { AttendanceMark, DrillType, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';

export interface CreateTrainingDto {
  title:        string;
  description?: string;
  location?:    string;
  scheduledAt:  string;
  duration:     number;
  drills?:      DrillType[];
  playerIds?:   string[];
}

export interface AttendanceMarkDto {
  playerId: string;
  mark:     AttendanceMark;
  notes?:   string;
}

// ─── New clean Create Session flow ────────────────────────────────────────
// Independent of createTrainingSession() above. Resolves playerIds against
// active club players, drops any that don't resolve (so a stale row in
// State.players can never poison the request), and only attempts the
// Prisma create with verified ids. Always returns the row the way the
// frontend expects (with playerStats.player), so it can land straight in
// the Sessions list.
export interface CleanCreateSessionDto {
  title:       string;
  scheduledAt: string;
  duration:    number;
  location?:   string;
  notes?:      string;
  drills?:     DrillType[];
  playerIds?:  string[];
}

export async function createCleanSession(clubId: string, dto: CleanCreateSessionDto) {
  if (!clubId) throw new BadRequestError('No active club context');

  let validPlayerIds: string[] = [];
  if (dto.playerIds && dto.playerIds.length > 0) {
    const owned = await prisma.player.findMany({
      where:  { id: { in: dto.playerIds }, clubId, isActive: true },
      select: { id: true },
    });
    validPlayerIds = owned.map((p) => p.id);
    if (validPlayerIds.length !== dto.playerIds.length) {
      const ownedSet = new Set(validPlayerIds);
      const missing  = dto.playerIds.filter((id) => !ownedSet.has(id));
      throw new BadRequestError(`Players not in active squad: ${missing.join(', ')}`);
    }
  }

  // NOTE: `location` intentionally NOT written here. The deployed Prisma
  // Client on Render predates the 20260602000000_training_location migration,
  // so include of `location` raises PrismaClientValidationError "Unknown
  // argument `location`". Zod still accepts `location` from the request body
  // so existing clients don't fail validation — it just isn't persisted until
  // the next full backend redeploy regenerates the Client against the
  // current schema.
  return prisma.trainingSession.create({
    data: {
      clubId,
      title:       dto.title,
      description: dto.notes ?? null,
      scheduledAt: new Date(dto.scheduledAt),
      duration:    dto.duration,
      drills:      dto.drills ?? [],
      ...(validPlayerIds.length && {
        playerStats: {
          create: validPlayerIds.map((pid) => ({ playerId: pid })),
        },
      }),
    },
    include: {
      playerStats: { include: { player: true } },
    },
  });
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
//
// Bug fixed: pre-verify every playerId belongs to an active player in the
// caller's club BEFORE attempting the nested playerStats.create. Without this,
// a stale / soft-deleted / out-of-club UUID raised Prisma P2003 inside the
// nested create which the global error handler doesn't recognise — surfacing
// as a generic 500 "Server error. Please retry shortly." to the client.
// Mirrors the same pre-flight setTrainingAttendance has below.
export async function createTrainingSession(
  clubId: string,
  dto: CreateTrainingDto
) {
  const { playerIds } = dto;

  if (playerIds && playerIds.length > 0) {
    const owned = await prisma.player.findMany({
      where:  { id: { in: playerIds }, clubId, isActive: true },
      select: { id: true },
    });
    if (owned.length !== playerIds.length) {
      const ownedSet = new Set(owned.map((p) => p.id));
      const missing  = playerIds.filter((id) => !ownedSet.has(id));
      throw new BadRequestError(
        `playerIds not found in this club: ${missing.join(', ')}`,
      );
    }
  }

  return prisma.trainingSession.create({
    data: {
      clubId,
      title:       dto.title,
      description: dto.description,
      location:    dto.location,
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
        ...(fields.location    !== undefined && { location:    fields.location }),
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

// ─────────────────────────────────────────────────────────────────────────
// Attendance — Training Attendance MVP
// Persisted in TrainingAttendanceRecord (one row per (session, player)).
// Active club players are the canonical roster; marks default to PRESENT
// only when an explicit row exists. Missing rows are reported as `null`
// (unmarked) so the UI can distinguish "not yet recorded" from PRESENT.
// ─────────────────────────────────────────────────────────────────────────

function summariseMarks(marks: AttendanceMark[]) {
  const counts = { present: 0, absent: 0, late: 0, excused: 0 };
  for (const m of marks) {
    if      (m === 'PRESENT') counts.present++;
    else if (m === 'ABSENT')  counts.absent++;
    else if (m === 'LATE')    counts.late++;
    else if (m === 'EXCUSED') counts.excused++;
  }
  return counts;
}

export async function getTrainingAttendance(sessionId: string, clubId: string) {
  await getTrainingById(sessionId, clubId);

  const [players, records] = await Promise.all([
    prisma.player.findMany({
      where:   { clubId, isActive: true },
      select:  { id: true, firstName: true, lastName: true, number: true, position: true },
      orderBy: [{ number: 'asc' }],
    }),
    prisma.trainingAttendanceRecord.findMany({
      where: { clubId, trainingSessionId: sessionId },
    }),
  ]);

  const byPlayer = new Map(records.map((r) => [r.playerId, r]));
  const items = players.map((p) => {
    const r = byPlayer.get(p.id);
    return {
      playerId:   p.id,
      firstName:  p.firstName,
      lastName:   p.lastName,
      number:     p.number,
      position:   p.position,
      mark:       r ? r.mark : null,
      notes:      r ? r.notes : null,
      recordedAt: r ? r.recordedAt : null,
    };
  });

  const summary = summariseMarks(records.map((r) => r.mark));
  return { sessionId, items, summary };
}

export async function setTrainingAttendance(
  sessionId: string,
  clubId: string,
  actorUserId: string,
  marks: AttendanceMarkDto[],
) {
  await getTrainingById(sessionId, clubId);

  // Reject marks for players outside this club — silently dropping would
  // mask UI bugs (wrong club context, stale State.players).
  if (marks.length > 0) {
    const playerIds = marks.map((m) => m.playerId);
    const owned = await prisma.player.findMany({
      where:  { id: { in: playerIds }, clubId },
      select: { id: true },
    });
    if (owned.length !== playerIds.length) {
      throw new ForbiddenError();
    }
  }

  await prisma.$transaction(
    marks.map((m) =>
      prisma.trainingAttendanceRecord.upsert({
        where:  { trainingSessionId_playerId: { trainingSessionId: sessionId, playerId: m.playerId } },
        create: {
          clubId,
          trainingSessionId: sessionId,
          playerId:          m.playerId,
          mark:              m.mark,
          notes:             m.notes,
          recordedById:      actorUserId,
        },
        update: {
          mark:         m.mark,
          notes:        m.notes,
          recordedById: actorUserId,
          recordedAt:   new Date(),
        },
      }),
    ),
  );

  return getTrainingAttendance(sessionId, clubId);
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
