import { AttendanceMark, DrillType, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  publishTrainingSessionCreated, publishTrainingSessionUpdated, publishTrainingSessionDeleted,
  publishTrainingAttendanceSaved, publishTrainingLocationChanged, publishTrainingStatusChanged,
  publishTrainingPlayerAdded, publishTrainingPlayerRemoved,
} from '../fabric/producers/training.producer';

// ─────────────────────────────────────────────────────────────────────────
// The Data Fabric adapter
// ─────────────────────────────────────────────────────────────────────────
//
// Every Training event goes through here and nowhere else. One name to scan
// for, one place the rules live, and one place the squad's KIND is resolved.
//
// WHY IT IS CALLED AFTER THE COMMIT, ALWAYS
//
// An event announces a fact to the rest of the platform. Announcing a session
// that then rolled back is worse than announcing nothing, so every call site
// below sits after its transaction has returned.
//
// WHY IT RESOLVES THE TEAM KIND ITSELF
//
// First-team and academy training are one lane, told apart by `teamKind`. Most
// call sites do not already know it, and making them `await` a lookup would put
// a read on the path of every attendance save. So the lookup happens inside the
// detached body: the caller returns immediately, and the event acquires its
// context a moment later. A coach must not wait on observability.

/** Every event this service may produce. One union, so the switch is total. */
type TrainingEventType =
  | 'training.session.created' | 'training.session.updated' | 'training.session.deleted'
  | 'training.attendance.saved' | 'training.location.changed' | 'training.status.changed'
  | 'training.player.added' | 'training.player.removed';

/**
 * What a particular event needs beyond the session itself.
 *
 * Deliberately narrow: COUNTS, FIELD NAMES and STATUS TOKENS. There is no
 * member of this type into which a location, a coach's note, an attendance
 * reason or a player id could be put.
 */
interface TrainingEventDetail {
  changedFields?: readonly string[];
  players?: number;
  drills?: number;
  marked?: number;
  count?: number;
  from?: string | null;
  to?: string | null;
}

interface TrainingSubject {
  id: string;
  clubId: string;
  teamId: string | null;
}

function emitTrainingEvent(
  eventType: TrainingEventType,
  session: TrainingSubject,
  actorUserId: string | null,
  detail: TrainingEventDetail = {},
): void {
  void (async () => {
    const kind = session.teamId
      ? (await prisma.team.findUnique({ where: { id: session.teamId }, select: { kind: true } }))?.kind ?? null
      : null;
    const ctx = {
      sessionId: session.id,
      clubId: session.clubId,
      teamId: session.teamId ?? null,
      actorUserId,
    };

    switch (eventType) {
      case 'training.session.created':
        publishTrainingSessionCreated(ctx, detail.players ?? 0, detail.drills ?? 0, kind); return;
      case 'training.session.updated':
        publishTrainingSessionUpdated(ctx, detail.changedFields ?? [], kind); return;
      case 'training.session.deleted':
        publishTrainingSessionDeleted(ctx, kind); return;
      case 'training.attendance.saved':
        publishTrainingAttendanceSaved(ctx, detail.marked ?? 0, kind); return;
      case 'training.location.changed':
        publishTrainingLocationChanged(ctx, kind); return;
      case 'training.status.changed':
        publishTrainingStatusChanged(ctx, detail.from ?? null, detail.to ?? null, kind); return;
      case 'training.player.added':
        publishTrainingPlayerAdded(ctx, detail.count ?? 0, kind); return;
      case 'training.player.removed':
        publishTrainingPlayerRemoved(ctx, detail.count ?? 0, kind); return;
      default: return;
    }
  })().catch((err) => {
    // A training operation that already succeeded must not be reported as
    // failed because the fabric was unwell.
    logger.warn('[fabric] a training event could not be recorded; the write stands', {
      eventType, sessionId: session.id, err: (err as Error)?.message,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Whose training week is this?
// ─────────────────────────────────────────────────────────────────────────
//
// A session belongs to a TEAM. The First Team trains apart from the
// Under-15s, and each week is private to the people assigned to that team, so
// every read below is filtered by the team the caller works on and every write
// is refused for a team they do not.
//
// A session with NO team is a legacy club session: one recorded before teams
// owned them, which the migration could not attribute without guessing. Those
// stay readable by the club's staff — they are nobody else's team's week — and
// only a club-wide administrator may change one, or adopt it by naming a team.

export interface TrainingTeamScope {
  /** A platform administrator, or a club-wide staff membership. */
  unrestricted: boolean;
  /** The teams this caller works on, when they do not work on all of them. */
  teamIds: string[];
}

/**
 * The team filter for one caller, as a where fragment.
 *
 * Returns `{}` for an unrestricted caller so the query is exactly the one it
 * always was, and an OR over their own teams plus the club's unattributed
 * sessions for everybody else.
 */
export function trainingTeamWhere(scope?: TrainingTeamScope | null): Prisma.TrainingSessionWhereInput {
  if (!scope || scope.unrestricted) return {};
  return { OR: [{ teamId: { in: scope.teamIds } }, { teamId: null }] };
}

/**
 * The team a session belongs to, and the club that owns it. Read by the route
 * gate before the handler runs, so a session id from another team's week is
 * refused rather than answered.
 */
export async function sessionOwnership(sessionId: string): Promise<{ clubId: string; teamId: string | null } | null> {
  return prisma.trainingSession.findUnique({
    where: { id: sessionId },
    select: { clubId: true, teamId: true },
  });
}

/**
 * The players a session may name: its team's squad, or — for a legacy session
 * with no team — the club's. A session can never carry a player from another
 * team, which is what stops one team's roster leaking into another's week.
 */
async function assertPlayersOfTeam(clubId: string, teamId: string | null, playerIds: string[]): Promise<void> {
  if (!playerIds.length) return;
  const ids = [...new Set(playerIds)];
  const owned = await prisma.player.findMany({
    where: { id: { in: ids }, clubId, ...(teamId ? { teamId } : {}) },
    select: { id: true },
  });
  if (owned.length !== ids.length) {
    const ownedSet = new Set(owned.map((p) => p.id));
    const missing = ids.filter((id) => !ownedSet.has(id));
    throw new BadRequestError(
      teamId
        ? `Players not in this team's squad: ${missing.join(', ')}`
        : `Players not in active squad: ${missing.join(', ')}`,
    );
  }
}

/** A team named on a write must be a real team of the caller's own club. */
async function assertTeamOfClub(clubId: string, teamId: string | null | undefined): Promise<string | null> {
  if (!teamId) return null;
  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { clubId: true } });
  if (!team || team.clubId !== clubId) throw new ForbiddenError();
  return teamId;
}

export interface CreateTrainingDto {
  title:        string;
  description?: string;
  location?:    string;
  scheduledAt:  string;
  duration:     number;
  drills?:      DrillType[];
  playerIds?:   string[];
  /** The team whose session this is. Checked against the caller's assignments
   *  by the route before the service is reached. */
  teamId?:      string | null;
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
  title:         string;
  scheduledAt:   string;
  duration:      number;
  location?:     string;
  notes?:        string;
  drills?:       DrillType[];
  playerIds?:    string[];
  /** The team whose session this is. */
  teamId?:       string | null;
  // Stage 2 planning metadata (additive, all optional).
  startTime?:    string;
  sessionType?:  string;
  objective?:    string;
  tacticalFocus?: string;
  formation?:    string;
  // Session-analytics context (additive, all optional).
  intensity?:    string;
  pitch?:        string;
  weather?:      string;
  temperature?:  string;
  equipment?:    string;
  coachName?:    string;
}

export async function createCleanSession(clubId: string, dto: CleanCreateSessionDto) {
  if (!clubId) throw new BadRequestError('No active club context');

  // The team this session belongs to, verified as this club's. Whether the
  // caller may create a session for it was decided by the route.
  const teamId = await assertTeamOfClub(clubId, dto.teamId ?? null);

  let validPlayerIds: string[] = [];
  if (dto.playerIds && dto.playerIds.length > 0) {
    const owned = await prisma.player.findMany({
      where:  { id: { in: dto.playerIds }, clubId, isActive: true, ...(teamId ? { teamId } : {}) },
      select: { id: true },
    });
    validPlayerIds = owned.map((p) => p.id);
    if (validPlayerIds.length !== dto.playerIds.length) {
      const ownedSet = new Set(validPlayerIds);
      const missing  = dto.playerIds.filter((id) => !ownedSet.has(id));
      throw new BadRequestError(
        teamId
          ? `Players not in this team's squad: ${missing.join(', ')}`
          : `Players not in active squad: ${missing.join(', ')}`,
      );
    }
  }

  // `location` is written, and has been since the migration below it shipped.
  // The note that used to sit here said the opposite and contradicted the line
  // that writes it — a workaround's obituary left in place long enough to be
  // read as current.
  const created = await prisma.trainingSession.create({
    data: {
      clubId,
      teamId,
      title:         dto.title,
      description:   dto.notes ?? null,
      location:      dto.location ?? null,
      scheduledAt:   new Date(dto.scheduledAt),
      duration:      dto.duration,
      drills:        dto.drills ?? [],
      startTime:     dto.startTime ?? null,
      sessionType:   dto.sessionType ?? null,
      objective:     dto.objective ?? null,
      tacticalFocus: dto.tacticalFocus ?? null,
      formation:     dto.formation ?? null,
      intensity:     dto.intensity ?? null,
      pitch:         dto.pitch ?? null,
      weather:       dto.weather ?? null,
      temperature:   dto.temperature ?? null,
      equipment:     dto.equipment ?? null,
      coachName:     dto.coachName ?? null,
      status:        'planned',
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

  // After the create. COUNTS, never ids — a roster of three is three children.
  emitTrainingEvent('training.session.created', created, null, {
    players: validPlayerIds.length, drills: (dto.drills ?? []).length,
  });
  return created;
}

export async function getTrainingSessions(
  clubId: string,
  filters: { page?: number; limit?: number; teamId?: string | null; scope?: TrainingTeamScope | null } = {}
) {
  const { page = 1, limit = 20 } = filters;
  const skip = (page - 1) * limit;

  // One team's week when a team is named — the route checked it — and
  // otherwise every session this caller works on. Never the club's whole
  // calendar for somebody assigned to one team of it.
  const where: Prisma.TrainingSessionWhereInput = {
    clubId,
    ...(filters.teamId ? { teamId: filters.teamId } : {}),
    ...trainingTeamWhere(filters.scope),
  };

  const [sessions, total] = await Promise.all([
    prisma.trainingSession.findMany({
      where,
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
    prisma.trainingSession.count({ where }),
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
  const teamId = await assertTeamOfClub(clubId, dto.teamId ?? null);

  if (playerIds && playerIds.length > 0) {
    await assertPlayersOfTeam(clubId, teamId, playerIds);
  }

  const created = await prisma.trainingSession.create({
    data: {
      clubId,
      teamId,
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

  // The same fact as the clean path produces, under the same name. Two routes
  // into one occurrence must not become two names for it.
  emitTrainingEvent('training.session.created', created, null, {
    players: playerIds?.length ?? 0, drills: (dto.drills ?? []).length,
  });
  return created;
}

// Bug fixed: playerIds was extracted but silently ignored. Now replaces the
// entire player roster inside a transaction so the operation is atomic.
export async function updateTrainingSession(
  id: string,
  clubId: string,
  dto: Partial<CreateTrainingDto>
) {
  // Ownership check before any write
  const existing = await getTrainingById(id, clubId);

  const { playerIds, teamId: newTeamId, ...fields } = dto;
  // Moving a session between teams is allowed — a legacy club session is
  // adopted this way — but the caller's right to BOTH teams was decided by the
  // route before this ran, and the team must be one of this club's.
  const teamId = newTeamId === undefined ? undefined : await assertTeamOfClub(clubId, newTeamId);
  const effectiveTeamId = teamId === undefined ? existing.teamId : teamId;

  if (playerIds !== undefined && playerIds.length) {
    await assertPlayersOfTeam(clubId, effectiveTeamId, playerIds);
  }

  // Captured BEFORE the write, by value. Read afterwards they would depend on
  // the update returning an object distinct from the one `existing` points at,
  // which is true of Prisma and is not a thing to rely on.
  const previousLocation = existing.location ?? null;
  const previousRoster = new Set((existing.playerStats ?? []).map((ps) => ps.playerId));

  await prisma.$transaction(async (tx) => {
    await tx.trainingSession.update({
      where: { id },
      data: {
        ...(fields.title       !== undefined && { title:       fields.title }),
        ...(fields.description !== undefined && { description: fields.description }),
        // `location` IS written. It stopped being written behind a workaround
        // for a deployed Prisma Client that predated
        // `20260602000000_training_location`; that migration has since shipped,
        // the column is in the schema, and both create paths have been writing
        // the field successfully ever since — which is the proof the Client
        // knows about it. The workaround outlived its cause and left the two
        // halves disagreeing: a session could be created with a location and
        // then never moved, with the PATCH returning 200 and discarding the
        // value. `training.location.changed` cannot be produced honestly while
        // that is true, which is how it came to light.
        ...(fields.location    !== undefined && { location:    fields.location }),
        ...(fields.scheduledAt !== undefined && { scheduledAt: new Date(fields.scheduledAt) }),
        ...(fields.duration    !== undefined && { duration:    fields.duration }),
        ...(fields.drills      !== undefined && { drills:      fields.drills }),
        ...(teamId             !== undefined && { teamId }),
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
  const updated = await getTrainingById(id, clubId);

  // ── the umbrella, then the specific facts ────────────────────────────────
  //
  // `training.session.updated` fires for every successful update and names the
  // fields the caller asked to change. The specific events fire only when that
  // thing actually MOVED — resending a session's existing location is not a
  // change of venue, and an event saying otherwise is a lie a consumer would
  // act on. Each is a different fact with a different name and sensitivity,
  // which is why they sit alongside the umbrella rather than replacing it.
  const changedFields = Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined);
  emitTrainingEvent('training.session.updated', updated, null, { changedFields });

  // A venue move is RESTRICTED and carries no value: an address plus a
  // scheduled time is where a named squad of children will be.
  if (fields.location !== undefined && (fields.location ?? null) !== previousLocation) {
    emitTrainingEvent('training.location.changed', updated, null);
  }

  // A roster change is reported as a COUNT in each direction. A session that
  // swaps one player for another genuinely added one and removed one.
  if (playerIds !== undefined) {
    const nextRoster = new Set(playerIds);
    let added = 0;
    for (const pid of nextRoster) if (!previousRoster.has(pid)) added += 1;
    let removed = 0;
    for (const pid of previousRoster) if (!nextRoster.has(pid)) removed += 1;
    emitTrainingEvent('training.player.added', updated, null, { count: added });
    emitTrainingEvent('training.player.removed', updated, null, { count: removed });
  }

  return updated;
}

export async function deleteTrainingSession(id: string, clubId: string) {
  const existing = await getTrainingById(id, clubId);
  await prisma.trainingSession.delete({ where: { id } });
  // After the delete, on the row as it was. The session no longer exists, so
  // the squad it belonged to is read from what was fetched a moment ago.
  emitTrainingEvent('training.session.deleted', existing, null);
}

// ─────────────────────────────────────────────────────────────────────────
// Attendance — Training Attendance MVP
// Persisted in TrainingAttendanceRecord (one row per (session, player)).
// Active club players are the canonical roster; marks default to PRESENT
// only when an explicit row exists. Missing rows are reported as `null`
// (unmarked) so the UI can distinguish "not yet recorded" from PRESENT.
// ─────────────────────────────────────────────────────────────────────────

function summariseMarks(marks: AttendanceMark[]) {
  const counts = { present: 0, absent: 0, late: 0, excused: 0, injured: 0 };
  for (const m of marks) {
    if      (m === 'PRESENT') counts.present++;
    else if (m === 'ABSENT')  counts.absent++;
    else if (m === 'LATE')    counts.late++;
    else if (m === 'EXCUSED') counts.excused++;
    else if (m === 'INJURED') counts.injured++;
  }
  return counts;
}

export async function getTrainingAttendance(sessionId: string, clubId: string) {
  const session = await getTrainingById(sessionId, clubId);

  const [players, records] = await Promise.all([
    prisma.player.findMany({
      // The roster is the session's TEAM, not the club. An Under-15 session
      // marked against the whole club's players would show a First Team squad
      // to whoever opened it — and would let a mark be recorded against them.
      where:   { clubId, isActive: true, ...(session.teamId ? { teamId: session.teamId } : {}) },
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
  const session = await getTrainingById(sessionId, clubId);

  // Reject marks for players outside this session's own team — silently
  // dropping would mask UI bugs (wrong club context, stale State.players), and
  // accepting them would record one team's attendance against another's squad.
  if (marks.length > 0) {
    const playerIds = marks.map((m) => m.playerId);
    const owned = await prisma.player.findMany({
      where:  { id: { in: playerIds }, clubId, ...(session.teamId ? { teamId: session.teamId } : {}) },
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

  // After the writes. HOW MANY marks were saved, and nothing else — not who,
  // not the mark, and above all not the note against it. An attendance reason
  // is the sort of thing safeguarding exists to protect.
  emitTrainingEvent('training.attendance.saved', session, actorUserId, { marked: marks.length });

  return getTrainingAttendance(sessionId, clubId);
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 2 — full session lifecycle persistence (planning → completion) and
// PostgreSQL-only reports. All player references are real Player UUIDs; every
// write is pre-validated against the caller's active club roster so a stale
// client id can never poison a row.
// ─────────────────────────────────────────────────────────────────────────

export interface PerformanceMarkDto {
  playerId:      string;
  rating?:       number | null;
  participation?: string | null;   // "full" | "partial"
  notes?:        string | null;
}

async function assertOwnedPlayers(clubId: string, playerIds: string[], teamId?: string | null) {
  if (playerIds.length === 0) return;
  const owned = await prisma.player.findMany({
    where:  { id: { in: playerIds }, clubId, ...(teamId ? { teamId } : {}) },
    select: { id: true },
  });
  if (owned.length !== new Set(playerIds).size) throw new ForbiddenError();
}

// Upsert per-player ratings / participation / notes onto PlayerTrainingStat
// (the row that ties a session to a real Player UUID).
export async function savePerformance(
  sessionId: string,
  clubId: string,
  marks: PerformanceMarkDto[],
  /**
   * Whether this call owns the operation the caller asked for.
   *
   * False when `completeSession` is walking through here on its way to
   * `completed`: the planned → in_progress step is real, but it is an
   * implementation detail of completion rather than a second thing the coach
   * did, and publishing both would put two status events on the board for one
   * action. Defaults to true, so a direct call announces itself.
   */
  announce = true,
) {
  const before = await prisma.trainingSession.findUnique({
    where: { id: sessionId }, select: { status: true },
  });
  const session = await getTrainingById(sessionId, clubId);
  await assertOwnedPlayers(clubId, marks.map((m) => m.playerId), session.teamId);

  await prisma.$transaction(
    marks.map((m) =>
      prisma.playerTrainingStat.upsert({
        where:  { sessionId_playerId: { sessionId, playerId: m.playerId } },
        create: {
          sessionId,
          playerId:      m.playerId,
          rating:        m.rating ?? null,
          participation: m.participation ?? null,
          notes:         m.notes ?? null,
        },
        update: {
          ...(m.rating        !== undefined && { rating:        m.rating }),
          ...(m.participation !== undefined && { participation: m.participation }),
          ...(m.notes         !== undefined && { notes:         m.notes }),
        },
      }),
    ),
  );

  // Mark the session in-progress once performance is recorded (matches client flow).
  const moved = await prisma.trainingSession.updateMany({
    where: { id: sessionId, status: { in: ['draft', 'planned'] } },
    data:  { status: 'in_progress' },
  });

  const after = await getTrainingById(sessionId, clubId);

  // Two conditions, and both matter.
  //
  // `moved.count` is the first: `updateMany` with a status filter is a no-op
  // when the session has already started, and a status event for a status that
  // did not change is noise in a log that must not have any.
  //
  // `announce` is the second, and it is the one rule 7 is about.
  // `completeSession` calls this function on its way to `completed`, so
  // publishing here would put planned → in_progress on the board alongside the
  // completion — two events for one thing the coach did. The caller that owns
  // the operation publishes; this one stays quiet when it is a step inside
  // somebody else's.
  if (announce && moved.count > 0) {
    emitTrainingEvent('training.status.changed', after, null, {
      from: before?.status ?? null, to: 'in_progress',
    });
  }

  return after;
}

export interface CompleteSessionDto {
  sessionRating?: number | null;
  bestPlayerId?:  string | null;
  coachNote?:     string | null;
  performance?:   PerformanceMarkDto[];
}

// Persist session completion in Postgres: status/completedAt/sessionRating/
// bestPlayerId/coachNote, plus any final per-player ratings in one flow.
export async function completeSession(
  sessionId: string,
  clubId: string,
  dto: CompleteSessionDto,
) {
  const session = await getTrainingById(sessionId, clubId);
  // The status it had when the coach pressed complete — before `savePerformance`
  // below walks it through `in_progress` on the way.
  const previousStatus = session.status;

  if (dto.bestPlayerId) await assertOwnedPlayers(clubId, [dto.bestPlayerId], session.teamId);
  if (dto.performance && dto.performance.length) {
    // `announce: false` — see the parameter's own note. Completing a session is
    // one action and produces one status event, published below.
    await savePerformance(sessionId, clubId, dto.performance, false);
  }

  await prisma.trainingSession.update({
    where: { id: sessionId },
    data: {
      status:        'completed',
      completedAt:   new Date(),
      sessionRating: dto.sessionRating ?? null,
      bestPlayerId:  dto.bestPlayerId ?? null,
      coachNote:     dto.coachNote ?? null,
    },
  });

  const completed = await getTrainingById(sessionId, clubId);

  // One event, after the commit, carrying the status the session really had
  // when the coach started — not the `in_progress` it passed through. Neither
  // the coach's note nor the session rating travels: one is free text an adult
  // wrote, the other is a judgement about children.
  emitTrainingEvent('training.status.changed', completed, null, {
    from: previousStatus, to: 'completed',
  });

  return completed;
}

// ── Reports (PostgreSQL only) ──────────────────────────────────────────────
// range: daily (today) | weekly (7d) | monthly (30d) | season (all).
function rangeWindow(range: string): { from: Date | null; label: string } {
  const now = new Date();
  const start = new Date(now);
  if (range === 'daily')   { start.setHours(0, 0, 0, 0); return { from: start, label: 'Daily' }; }
  if (range === 'weekly')  { start.setDate(now.getDate() - 7);  return { from: start, label: 'Weekly' }; }
  if (range === 'monthly') { start.setDate(now.getDate() - 30); return { from: start, label: 'Monthly' }; }
  return { from: null, label: 'Season' }; // season = everything for the club
}

export async function getTrainingReport(
  clubId: string,
  range: string,
  opts: { teamId?: string | null; scope?: TrainingTeamScope | null } = {},
) {
  const { from, label } = rangeWindow(range);
  const teamId = opts.teamId ?? null;

  const sessionWhere: Prisma.TrainingSessionWhereInput = {
    clubId,
    ...(from ? { scheduledAt: { gte: from } } : {}),
    ...(teamId ? { teamId } : {}),
    ...trainingTeamWhere(opts.scope),
  };
  // The sessions this report is about, read first: a TrainingAttendanceRecord
  // carries a session id and no team of its own, so the only honest way to
  // scope attendance is by the sessions the caller may actually read.
  const scopedSessions = await prisma.trainingSession.findMany({
    where: sessionWhere,
    select: { id: true },
  });
  const scopedIds = scopedSessions.map((r) => r.id);
  const narrowed = !!teamId || !!(opts.scope && !opts.scope.unrestricted);
  const attWhere: Prisma.TrainingAttendanceRecordWhereInput = {
    clubId,
    ...(from ? { recordedAt: { gte: from } } : {}),
    ...(narrowed ? { trainingSessionId: { in: scopedIds } } : {}),
  };

  const [sessions, players, attendance] = await Promise.all([
    prisma.trainingSession.findMany({
      where: sessionWhere,
      include: { playerStats: { select: { playerId: true, rating: true, participation: true } } },
      orderBy: { scheduledAt: 'desc' },
    }),
    prisma.player.findMany({
      // A team's report is about that team's players. Reported per-player rows
      // for a squad the reader does not work on would be the same leak the
      // session list closes, arriving by a different route.
      where:  {
        clubId, isActive: true,
        ...(teamId ? { teamId } : {}),
        ...(opts.scope && !opts.scope.unrestricted ? { OR: [{ teamId: { in: opts.scope.teamIds } }, { teamId: null }] } : {}),
      },
      select: { id: true, firstName: true, lastName: true, number: true, position: true },
    }),
    prisma.trainingAttendanceRecord.findMany({
      where: attWhere,
      select: { playerId: true, mark: true, trainingSessionId: true },
    }),
  ]);

  const completed = sessions.filter((s) => s.status === 'completed');

  // Attendance summary across the window (from real attendance rows).
  const attCounts = { present: 0, late: 0, absent: 0, excused: 0, injured: 0 };
  for (const r of attendance) {
    if      (r.mark === 'PRESENT') attCounts.present++;
    else if (r.mark === 'LATE')    attCounts.late++;
    else if (r.mark === 'ABSENT')  attCounts.absent++;
    else if (r.mark === 'EXCUSED') attCounts.excused++;
    else if (r.mark === 'INJURED') attCounts.injured++;
  }
  const attended = attCounts.present + attCounts.late;
  const attDenom = attended + attCounts.absent;
  const attendancePct = attDenom ? Math.round((attended / attDenom) * 100) : null;

  const sessionRatings = completed
    .map((s) => s.sessionRating)
    .filter((r): r is number => typeof r === 'number');
  const avgSessionRating = sessionRatings.length
    ? +(sessionRatings.reduce((a, b) => a + b, 0) / sessionRatings.length).toFixed(2)
    : null;

  // Per-player aggregates (real UUIDs) from PlayerTrainingStat + attendance rows.
  const attByPlayer = new Map<string, { present: number; late: number; absent: number; excused: number; injured: number }>();
  for (const r of attendance) {
    const a = attByPlayer.get(r.playerId) || { present: 0, late: 0, absent: 0, excused: 0, injured: 0 };
    if      (r.mark === 'PRESENT') a.present++;
    else if (r.mark === 'LATE')    a.late++;
    else if (r.mark === 'ABSENT')  a.absent++;
    else if (r.mark === 'EXCUSED') a.excused++;
    else if (r.mark === 'INJURED') a.injured++;
    attByPlayer.set(r.playerId, a);
  }
  const ratingsByPlayer = new Map<string, number[]>();
  for (const s of completed) {
    for (const st of s.playerStats) {
      if (typeof st.rating === 'number') {
        const arr = ratingsByPlayer.get(st.playerId) || [];
        arr.push(st.rating);
        ratingsByPlayer.set(st.playerId, arr);
      }
    }
  }

  const perPlayer = players.map((p) => {
    const a = attByPlayer.get(p.id) || { present: 0, late: 0, absent: 0, excused: 0, injured: 0 };
    const att = a.present + a.late;
    const denom = att + a.absent;
    const ratings = ratingsByPlayer.get(p.id) || [];
    return {
      playerId:      p.id,
      name:          `${p.firstName} ${p.lastName}`,
      number:        p.number,
      position:      p.position,
      attendancePct: denom ? Math.round((att / denom) * 100) : null,
      avgRating:     ratings.length ? +(ratings.reduce((x, y) => x + y, 0) / ratings.length).toFixed(2) : null,
      sessions:      denom,
    };
  });

  const rated = perPlayer.filter((p) => p.avgRating != null);
  const topPlayers = rated.slice().sort((a, b) => (b.avgRating! - a.avgRating!)).slice(0, 5);
  const bestPlayer = topPlayers[0] || null;

  return {
    range: label,
    from:  from ? from.toISOString() : null,
    to:    new Date().toISOString(),
    totals: {
      sessions:   sessions.length,
      completed:  completed.length,
      planned:    sessions.filter((s) => s.status === 'planned').length,
      inProgress: sessions.filter((s) => s.status === 'in_progress').length,
    },
    attendance: { ...attCounts, attendancePct },
    avgSessionRating,
    bestPlayer,
    topPlayers,
    perPlayer,
  };
}

export async function getTrainingForm(
  clubId: string,
  opts: { teamId?: string | null; scope?: TrainingTeamScope | null } = {},
) {
  const latest = await prisma.trainingSession.findFirst({
    where: {
      clubId,
      ...(opts.teamId ? { teamId: opts.teamId } : {}),
      ...trainingTeamWhere(opts.scope),
    },
    orderBy: { scheduledAt: 'desc' },
    select: {
      attackForm:    true,
      defenseForm:   true,
      possession:    true,
      conditionForm: true,
    },
  });
  // BUG #2 fix: fallback for a brand-new club (no sessions yet) must match
  // the TrainingSession schema @default values. Previously this returned
  // { 10, 12, 9, 11 } while the schema defaults are { 12, 14, 11, 13 } — so
  // the rings would jump the moment the club created its first session,
  // even though no rating was edited. Source of truth is the schema; mirror
  // it here.
  return latest ?? { attackForm: 12, defenseForm: 14, possession: 11, conditionForm: 13 };
}
