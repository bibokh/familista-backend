// Familista — Player service (Phase 2)
// ─────────────────────────────────────────────────────────────────────────
// All player CRUD is club-scoped: every read/write enforces that the
// caller's clubId matches the player's clubId (or the caller is SUPER_ADMIN).
// Soft-delete uses Player.isActive — physical delete is gated to admins only
// and goes through deletePlayerHard.
//
// Every privileged write writes one PlayerAuditLog row inside the same
// transaction as the mutation, so audit + state stay consistent on failure.

import {
  Player,
  PlayerPosition,
  MedicalStatus,
  PaymentStatus,
  PlayerAuditAction,
  PlayerAttribute,
  Prisma,
} from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError, ConflictError } from '../utils/errors';

// ─────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────

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

  preferredFoot?: 'RIGHT' | 'LEFT' | 'BOTH';
  overallRating?: number;
  potential?: number;
  marketValue?: number;
  weeklyWage?: number;
  contractUntil?: string;
  avatar?: string;

  // Phase 2
  email?: string;
  parentName?: string;
  parentEmail?: string;
  parentPhone?: string;
  medicalStatus?: MedicalStatus;
  paymentStatus?: PaymentStatus;
  isActive?: boolean;
  notes?: string;
  joinedAt?: string;

  // Phase A
  teamId?: string | null;
}

export interface UpdatePlayerDto extends Partial<CreatePlayerDto> {
  condition?: number;
  isInjured?: boolean;
}

export type PlayerSortKey =
  | 'name' | 'number' | 'position' | 'overallRating' | 'joinedAt' | 'createdAt';

export interface PlayerFilters {
  position?:      PlayerPosition;
  isInjured?:     boolean;
  isActive?:      boolean;
  medicalStatus?: MedicalStatus;
  paymentStatus?: PaymentStatus;
  search?:        string;
  minRating?:     number;
  maxRating?:     number;
  sortBy?:        PlayerSortKey;
  sortOrder?:     'asc' | 'desc';
  page?:          number;
  limit?:         number;
  // Phase A — scope by team
  teamId?:        string | 'NULL';   // 'NULL' = unassigned (no team)
}

// Actor passed in by the controller for audit attribution.
export interface PlayerActor {
  userId:     string;
  clubId:     string;
  role?:      string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const ORDER_KEY: Record<PlayerSortKey, Prisma.PlayerOrderByWithRelationInput> = {
  name:          { lastName: 'asc' },
  number:        { number: 'asc' },
  position:      { position: 'asc' },
  overallRating: { overallRating: 'desc' },
  joinedAt:      { joinedAt: 'desc' },
  createdAt:     { createdAt: 'desc' },
};

function orderClause(sortBy?: PlayerSortKey, sortOrder?: 'asc' | 'desc'): Prisma.PlayerOrderByWithRelationInput {
  const base = ORDER_KEY[sortBy ?? 'overallRating'];
  if (!sortOrder) return base;
  // Swap direction
  const [k] = Object.entries(base)[0];
  return { [k]: sortOrder } as Prisma.PlayerOrderByWithRelationInput;
}

function snapshot(p: Player): Record<string, unknown> {
  // Only persist scalar fields in the audit log — avoid huge nested includes.
  const {
    id, firstName, lastName, number, position, nationality, flag, dateOfBirth,
    height, weight, preferredFoot, overallRating, potential, condition, isInjured,
    marketValue, weeklyWage, contractUntil, avatar, email, parentName, parentEmail,
    parentPhone, medicalStatus, paymentStatus, isActive, notes, joinedAt, clubId,
  } = p;
  return {
    id, firstName, lastName, number, position, nationality, flag, dateOfBirth,
    height, weight, preferredFoot, overallRating, potential, condition, isInjured,
    marketValue, weeklyWage, contractUntil, avatar, email, parentName, parentEmail,
    parentPhone, medicalStatus, paymentStatus, isActive, notes, joinedAt, clubId,
  };
}

// Enforces uniqueness of shirt number within active players of the same club.
// We DON'T put a @@unique on the schema so the migration doesn't fail if any
// historical duplicates already exist.
async function assertShirtNumberFree(
  clubId: string,
  number: number,
  excludePlayerId?: string,
): Promise<void> {
  const where: Prisma.PlayerWhereInput = {
    clubId,
    number,
    isActive: true,
    ...(excludePlayerId ? { NOT: { id: excludePlayerId } } : {}),
  };
  const clash = await prisma.player.findFirst({ where, select: { id: true, firstName: true, lastName: true } });
  if (clash) {
    throw new ConflictError(
      `Shirt #${number} is already taken by ${clash.firstName} ${clash.lastName}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────────────────

export async function getPlayers(clubId: string, filters: PlayerFilters = {}) {
  const {
    position, isInjured, isActive, medicalStatus, paymentStatus,
    search, minRating, maxRating, sortBy, sortOrder,
    page = 1, limit = 50,
  } = filters;
  const skip = (page - 1) * limit;

  const where: Prisma.PlayerWhereInput = {
    clubId,
    ...(position           && { position }),
    ...(medicalStatus      && { medicalStatus }),
    ...(paymentStatus      && { paymentStatus }),
    ...(isInjured !== undefined && { isInjured }),
    // Soft-deleted players (isActive=false) must NOT leak into the default
    // list — otherwise DELETE looks reverted after refresh / re-login.
    // Callers wanting archived rows pass ?isActive=false explicitly.
    isActive: isActive === undefined ? true : isActive,
    ...(filters.teamId === 'NULL' ? { teamId: null } : filters.teamId ? { teamId: filters.teamId } : {}),
    ...((minRating != null || maxRating != null) && {
      overallRating: {
        ...(minRating != null ? { gte: minRating } : {}),
        ...(maxRating != null ? { lte: maxRating } : {}),
      },
    }),
    ...(search && {
      OR: [
        { firstName:   { contains: search, mode: 'insensitive' } },
        { lastName:    { contains: search, mode: 'insensitive' } },
        { nationality: { contains: search, mode: 'insensitive' } },
        { email:       { contains: search, mode: 'insensitive' } },
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
      orderBy: orderClause(sortBy, sortOrder),
      skip,
      take: limit,
    }),
    prisma.player.count({ where }),
  ]);

  return { players, total, page, limit };
}

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

// ─────────────────────────────────────────────────────────────────────────
// WRITE (every mutation also writes a PlayerAuditLog row)
// ─────────────────────────────────────────────────────────────────────────

// Validate the requested teamId belongs to the actor's club (or is null).
async function assertTeamInClub(clubId: string, teamId: string | null | undefined): Promise<void> {
  if (!teamId) return;
  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { clubId: true, isActive: true } });
  if (!team)                       throw new NotFoundError('Team');
  if (team.clubId !== clubId)      throw new ForbiddenError();
}

export async function createPlayer(actor: PlayerActor, dto: CreatePlayerDto): Promise<Player> {
  await assertShirtNumberFree(actor.clubId, dto.number);
  await assertTeamInClub(actor.clubId, dto.teamId ?? null);

  return prisma.$transaction(async (tx) => {
    const player = await tx.player.create({
      data: {
        firstName:    dto.firstName,
        lastName:     dto.lastName,
        number:       dto.number,
        position:     dto.position,
        nationality:  dto.nationality,
        flag:         dto.flag,
        dateOfBirth:  new Date(dto.dateOfBirth),
        height:       dto.height,
        weight:       dto.weight,
        preferredFoot:dto.preferredFoot,
        overallRating:dto.overallRating,
        potential:    dto.potential,
        marketValue:  dto.marketValue,
        weeklyWage:   dto.weeklyWage,
        contractUntil:dto.contractUntil ? new Date(dto.contractUntil) : undefined,
        avatar:       dto.avatar,
        email:        dto.email,
        parentName:   dto.parentName,
        parentEmail:  dto.parentEmail,
        parentPhone:  dto.parentPhone,
        medicalStatus:dto.medicalStatus,
        paymentStatus:dto.paymentStatus,
        isActive:     dto.isActive ?? true,
        notes:        dto.notes,
        joinedAt:     dto.joinedAt ? new Date(dto.joinedAt) : undefined,
        teamId:       dto.teamId ?? null,
        clubId:       actor.clubId,
      },
    });
    await tx.playerAuditLog.create({
      data: {
        playerId: player.id,
        clubId:   actor.clubId,
        userId:   actor.userId,
        action:   PlayerAuditAction.CREATE,
        after:    snapshot(player) as Prisma.InputJsonValue,
        ipAddress: actor.ipAddress ?? undefined,
        userAgent: actor.userAgent ?? undefined,
      },
    });
    return player;
  });
}

export async function updatePlayer(actor: PlayerActor, id: string, dto: UpdatePlayerDto): Promise<Player> {
  const existing = await getPlayerById(id, actor.clubId);

  if (dto.number !== undefined && dto.number !== existing.number) {
    await assertShirtNumberFree(actor.clubId, dto.number, id);
  }
  if (dto.teamId !== undefined) {
    await assertTeamInClub(actor.clubId, dto.teamId);
  }

  return prisma.$transaction(async (tx) => {
    const data: Prisma.PlayerUpdateInput = {
      ...(dto.firstName     !== undefined && { firstName:     dto.firstName }),
      ...(dto.lastName      !== undefined && { lastName:      dto.lastName }),
      ...(dto.number        !== undefined && { number:        dto.number }),
      ...(dto.position      !== undefined && { position:      dto.position }),
      ...(dto.nationality   !== undefined && { nationality:   dto.nationality }),
      ...(dto.flag          !== undefined && { flag:          dto.flag }),
      ...(dto.dateOfBirth   !== undefined && { dateOfBirth:   new Date(dto.dateOfBirth) }),
      ...(dto.height        !== undefined && { height:        dto.height }),
      ...(dto.weight        !== undefined && { weight:        dto.weight }),
      ...(dto.preferredFoot !== undefined && { preferredFoot: dto.preferredFoot }),
      ...(dto.overallRating !== undefined && { overallRating: dto.overallRating }),
      ...(dto.potential     !== undefined && { potential:     dto.potential }),
      ...(dto.condition     !== undefined && { condition:     dto.condition }),
      ...(dto.isInjured     !== undefined && { isInjured:     dto.isInjured }),
      ...(dto.marketValue   !== undefined && { marketValue:   dto.marketValue }),
      ...(dto.weeklyWage    !== undefined && { weeklyWage:    dto.weeklyWage }),
      ...(dto.contractUntil !== undefined && { contractUntil: dto.contractUntil ? new Date(dto.contractUntil) : null }),
      ...(dto.avatar        !== undefined && { avatar:        dto.avatar }),
      ...(dto.email         !== undefined && { email:         dto.email }),
      ...(dto.parentName    !== undefined && { parentName:    dto.parentName }),
      ...(dto.parentEmail   !== undefined && { parentEmail:   dto.parentEmail }),
      ...(dto.parentPhone   !== undefined && { parentPhone:   dto.parentPhone }),
      ...(dto.medicalStatus !== undefined && { medicalStatus: dto.medicalStatus }),
      ...(dto.paymentStatus !== undefined && { paymentStatus: dto.paymentStatus }),
      ...(dto.isActive      !== undefined && { isActive:      dto.isActive }),
      ...(dto.notes         !== undefined && { notes:         dto.notes }),
      ...(dto.joinedAt      !== undefined && { joinedAt:      new Date(dto.joinedAt) }),
      ...(dto.teamId        !== undefined && { teamId:        dto.teamId ?? null }),
    };

    const updated = await tx.player.update({ where: { id }, data });

    // Specialised audit actions when status changes
    let action: PlayerAuditAction = PlayerAuditAction.UPDATE;
    if      (dto.medicalStatus !== undefined && dto.medicalStatus !== existing.medicalStatus) action = PlayerAuditAction.MEDICAL_STATUS_CHANGED;
    else if (dto.paymentStatus !== undefined && dto.paymentStatus !== existing.paymentStatus) action = PlayerAuditAction.PAYMENT_STATUS_CHANGED;
    else if (dto.isActive === false && existing.isActive)                                     action = PlayerAuditAction.DEACTIVATE;
    else if (dto.isActive === true  && !existing.isActive)                                    action = PlayerAuditAction.REACTIVATE;

    await tx.playerAuditLog.create({
      data: {
        playerId: id,
        clubId:   actor.clubId,
        userId:   actor.userId,
        action,
        before:   snapshot(existing as Player) as Prisma.InputJsonValue,
        after:    snapshot(updated)            as Prisma.InputJsonValue,
        ipAddress: actor.ipAddress ?? undefined,
        userAgent: actor.userAgent ?? undefined,
      },
    });
    return updated;
  });
}

// Soft-delete: flips isActive=false and writes a DEACTIVATE audit row.
// Use `deletePlayerHard` for irreversible removal (CLUB_ADMIN only).
export async function softDeletePlayer(actor: PlayerActor, id: string, reason?: string): Promise<void> {
  const existing = await getPlayerById(id, actor.clubId);
  if (!existing.isActive) return; // idempotent
  await prisma.$transaction(async (tx) => {
    await tx.player.update({ where: { id }, data: { isActive: false } });
    await tx.playerAuditLog.create({
      data: {
        playerId: id,
        clubId:   actor.clubId,
        userId:   actor.userId,
        action:   PlayerAuditAction.DEACTIVATE,
        before:   snapshot(existing as Player) as Prisma.InputJsonValue,
        reason,
        ipAddress: actor.ipAddress ?? undefined,
        userAgent: actor.userAgent ?? undefined,
      },
    });
  });
}

export async function reactivatePlayer(actor: PlayerActor, id: string, reason?: string): Promise<Player> {
  const existing = await getPlayerById(id, actor.clubId);
  if (existing.isActive) return existing as Player;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.player.update({ where: { id }, data: { isActive: true } });
    await tx.playerAuditLog.create({
      data: {
        playerId: id,
        clubId:   actor.clubId,
        userId:   actor.userId,
        action:   PlayerAuditAction.REACTIVATE,
        after:    snapshot(updated) as Prisma.InputJsonValue,
        reason,
        ipAddress: actor.ipAddress ?? undefined,
        userAgent: actor.userAgent ?? undefined,
      },
    });
    return updated;
  });
}

// Hard delete — physical removal. Kept for backwards compatibility but
// the route is locked to CLUB_ADMIN. Audit row is written BEFORE delete so
// the audit survives the cascade.
export async function deletePlayerHard(actor: PlayerActor, id: string, reason?: string): Promise<void> {
  const existing = await getPlayerById(id, actor.clubId);
  await prisma.$transaction(async (tx) => {
    await tx.playerAuditLog.create({
      data: {
        playerId: id,
        clubId:   actor.clubId,
        userId:   actor.userId,
        action:   PlayerAuditAction.DELETE,
        before:   snapshot(existing as Player) as Prisma.InputJsonValue,
        reason,
        ipAddress: actor.ipAddress ?? undefined,
        userAgent: actor.userAgent ?? undefined,
      },
    });
    await tx.player.delete({ where: { id } });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// GPS
// ─────────────────────────────────────────────────────────────────────────

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
  },
) {
  await getPlayerById(playerId, clubId);
  return prisma.playerGpsData.create({ data: { playerId, ...data } });
}

// ─────────────────────────────────────────────────────────────────────────
// Summaries
// ─────────────────────────────────────────────────────────────────────────

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

export async function getPlayerAttendance(playerId: string, clubId: string) {
  await getPlayerById(playerId, clubId);

  // Training attendance via PlayerTrainingStat rows. Only schema-valid fields
  // are aggregated here; richer metrics (rpe / load / distance) live on the
  // Phase O TrainingAttendanceRecord + Phase K BiomechanicalPacket surfaces.
  const [aggregate, recent] = await Promise.all([
    prisma.playerTrainingStat.aggregate({
      where:  { playerId },
      _count: { _all: true },
      _avg:   { rating: true },
    }),
    prisma.playerTrainingStat.findMany({
      where:   { playerId },
      include: { session: { select: { id: true, title: true, scheduledAt: true, duration: true } } },
      orderBy: { session: { scheduledAt: 'desc' } },
      take:    10,
    }),
  ]);

  return {
    aggregate: {
      sessions:  aggregate._count?._all ?? 0,
      avgRating: aggregate._avg?.rating ?? null,
    },
    recent: recent.map((r) => ({
      sessionId:   r.session.id,
      title:       r.session.title,
      scheduledAt: r.session.scheduledAt,
      durationMin: r.session.duration,
      attended:    r.attended,
      rating:      r.rating,
      notes:       r.notes,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Audit reads
// ─────────────────────────────────────────────────────────────────────────

export async function getPlayerAudit(
  playerId: string,
  clubId: string,
  opts: { page?: number; limit?: number; action?: PlayerAuditAction } = {},
) {
  await getPlayerById(playerId, clubId);
  const page  = Math.max(1, opts.page  ?? 1);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const where: Prisma.PlayerAuditLogWhereInput = {
    playerId,
    clubId,
    ...(opts.action ? { action: opts.action } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.playerAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    limit,
    }),
    prisma.playerAuditLog.count({ where }),
  ]);
  return { items: rows, total, page, limit };
}

// ─────────────────────────────────────────────────────────────────────────
// Performance / Player Attributes
// ─────────────────────────────────────────────────────────────────────────

export interface AttributeDto {
  speed?:     number; // stored as pace
  agility?:   number;
  stamina?:   number;
  strength?:  number;
  balance?:   number;
  reaction?:  number; // stored as reflexes
  technique?: number; // stored as dribbling
  passing?:   number;
  shooting?:  number;
  defending?: number; // stored as tackling
}

function mapAttr(a: PlayerAttribute) {
  return {
    id:        a.id,
    playerId:  a.playerId,
    recordedAt:a.recordedAt,
    speed:     a.pace,
    agility:   a.agility,
    stamina:   a.stamina,
    strength:  a.strength,
    balance:   a.balance,
    reaction:  a.reflexes,
    technique: a.dribbling,
    passing:   a.passing,
    shooting:  a.shooting,
    defending: a.tackling,
  };
}

export async function recordPlayerAttributes(
  actor: PlayerActor,
  playerId: string,
  dto: AttributeDto,
): Promise<ReturnType<typeof mapAttr>> {
  const player = await prisma.player.findUnique({
    where:  { id: playerId },
    select: { clubId: true },
  });
  if (!player) throw new NotFoundError('Player');
  if (player.clubId !== actor.clubId) throw new ForbiddenError();

  const attr = await prisma.playerAttribute.create({
    data: {
      playerId,
      pace:      dto.speed     ?? null,
      agility:   dto.agility   ?? null,
      stamina:   dto.stamina   ?? null,
      strength:  dto.strength  ?? null,
      balance:   dto.balance   ?? null,
      reflexes:  dto.reaction  ?? null,
      dribbling: dto.technique ?? null,
      passing:   dto.passing   ?? null,
      shooting:  dto.shooting  ?? null,
      tackling:  dto.defending ?? null,
    },
  });
  return mapAttr(attr);
}

export async function getPlayerAttributeHistory(
  actor: PlayerActor,
  playerId: string,
): Promise<ReturnType<typeof mapAttr>[]> {
  const player = await prisma.player.findUnique({
    where:  { id: playerId },
    select: { clubId: true },
  });
  if (!player) throw new NotFoundError('Player');
  if (player.clubId !== actor.clubId) throw new ForbiddenError();

  const attrs = await prisma.playerAttribute.findMany({
    where:   { playerId },
    orderBy: { recordedAt: 'desc' },
  });
  return attrs.map(mapAttr);
}

export async function getSquadPerformance(clubId: string) {
  const players = await prisma.player.findMany({
    where: { clubId, isActive: true },
    select: {
      id: true, firstName: true, lastName: true,
      number: true, position: true, overallRating: true, avatar: true,
      attributes: { orderBy: { recordedAt: 'desc' }, take: 1 },
    },
    orderBy: { overallRating: 'desc' },
  });
  return players.map((p) => ({
    id:            p.id,
    firstName:     p.firstName,
    lastName:      p.lastName,
    number:        p.number,
    position:      p.position,
    overallRating: p.overallRating,
    avatar:        p.avatar,
    attributes:    p.attributes[0] ? mapAttr(p.attributes[0]) : null,
  }));
}
