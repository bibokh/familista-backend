// Familista — Universal Athlete Identity (Phase N)
// ─────────────────────────────────────────────────────────────────────────
// Privacy-preserving cross-club identity. UniversalAthleteId.idHash is
// SHA-256( firstName_lower | lastName_lower | dateOfBirth_ISO | sport ).
// Raw PII never lands in this table.

import { createHash } from 'crypto';
import { AthleteIdentityLink, AthleteMedicalHistory, AthletePerformanceHistory, AthleteTransferHistory, Prisma, SportKind, TalentEvolutionGraph, UniversalAthleteId } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface IdentityActor {
  userId: string;
  clubId: string;
  role?:  string;
}

export function fingerprintAthlete(firstName: string, lastName: string, dateOfBirthISO: string, sport: SportKind): string {
  const seed = [
    String(firstName ?? '').trim().toLowerCase(),
    String(lastName ?? '').trim().toLowerCase(),
    String(dateOfBirthISO ?? '').trim(),
    String(sport ?? 'FOOTBALL'),
  ].join('|');
  return createHash('sha256').update(seed).digest('hex');
}

// ── UniversalAthleteId ──────────────────────────────────────────────────

export interface RegisterAthleteDto {
  firstName:      string;
  lastName:       string;
  dateOfBirth:    string;
  sport?:         SportKind;
  /** Optional Player.id to link in the same call. */
  playerId?:      string;
  confidence?:    number;
}

export async function registerUniversalAthlete(actor: IdentityActor, dto: RegisterAthleteDto): Promise<{ athlete: UniversalAthleteId; link?: AthleteIdentityLink }> {
  if (!dto.firstName || !dto.lastName || !dto.dateOfBirth) throw new BadRequestError('firstName + lastName + dateOfBirth required');
  const sport  = dto.sport ?? 'FOOTBALL';
  const idHash = fingerprintAthlete(dto.firstName, dto.lastName, dto.dateOfBirth, sport);
  const athlete = await prisma.universalAthleteId.upsert({
    where:  { idHash },
    create: { idHash, sport },
    update: { /* immutable identity row */ },
  });
  let link: AthleteIdentityLink | undefined;
  if (dto.playerId) {
    // Verify the Player belongs to the actor's club.
    const player = await prisma.player.findUnique({ where: { id: dto.playerId }, select: { clubId: true } });
    if (!player || (player.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError('Player not in club');
    link = await prisma.athleteIdentityLink.upsert({
      where:  { athleteId_playerId: { athleteId: athlete.id, playerId: dto.playerId } },
      create: { athleteId: athlete.id, playerId: dto.playerId, clubId: actor.clubId, confidence: Math.max(0, Math.min(1, dto.confidence ?? 1.0)), linkedById: actor.userId },
      update: { confidence: Math.max(0, Math.min(1, dto.confidence ?? 1.0)) },
    });
  }
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'UNIVERSAL_ATHLETE_REGISTERED',
    entityType: 'UniversalAthleteId', entityId: athlete.id,
    payload: { sport, idHash, linkedPlayer: dto.playerId ?? null },
  });
  return { athlete, link };
}

export async function linkPlayer(actor: IdentityActor, athleteIdHash: string, playerId: string, confidence = 1.0): Promise<AthleteIdentityLink> {
  if (!athleteIdHash || !playerId) throw new BadRequestError('athleteIdHash + playerId required');
  const athlete = await prisma.universalAthleteId.findUnique({ where: { idHash: athleteIdHash } });
  if (!athlete) throw new NotFoundError('UniversalAthleteId');
  const player = await prisma.player.findUnique({ where: { id: playerId }, select: { clubId: true } });
  if (!player || (player.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError('Player not in club');
  const link = await prisma.athleteIdentityLink.upsert({
    where:  { athleteId_playerId: { athleteId: athlete.id, playerId } },
    create: { athleteId: athlete.id, playerId, clubId: actor.clubId, confidence: Math.max(0, Math.min(1, confidence)), linkedById: actor.userId },
    update: { confidence: Math.max(0, Math.min(1, confidence)) },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'UNIVERSAL_ATHLETE_LINKED',
    entityType: 'AthleteIdentityLink', entityId: link.id,
    payload: { athleteIdHash, playerId },
  });
  return link;
}

export async function listLinks(actor: IdentityActor, athleteId: string): Promise<AthleteIdentityLink[]> {
  return prisma.athleteIdentityLink.findMany({
    where: { athleteId, OR: [{ clubId: actor.clubId }, ...(actor.role === 'SUPER_ADMIN' ? [{}] : [])] },
    orderBy: { linkedAt: 'desc' },
  });
}

// ── Performance history ────────────────────────────────────────────────

export async function recordPerformance(actor: IdentityActor, athleteId: string, season: string, payload: Prisma.InputJsonValue): Promise<AthletePerformanceHistory> {
  if (!athleteId || !season) throw new BadRequestError('athleteId + season required');
  // Verify there's at least one link from this club (or SUPER_ADMIN).
  if (actor.role !== 'SUPER_ADMIN') {
    const link = await prisma.athleteIdentityLink.findFirst({ where: { athleteId, clubId: actor.clubId } });
    if (!link) throw new ForbiddenError('Athlete not linked to caller club');
  }
  return prisma.athletePerformanceHistory.create({
    data: { athleteId, season, payload },
  });
}

export async function listPerformance(athleteId: string, season?: string): Promise<AthletePerformanceHistory[]> {
  return prisma.athletePerformanceHistory.findMany({
    where: { athleteId, ...(season ? { season } : {}) },
    orderBy: { capturedAt: 'desc' },
    take: 200,
  });
}

// ── Medical history (k-anonymised) ─────────────────────────────────────

export async function recordMedical(actor: IdentityActor, athleteId: string, recordKind: string, plainPayload: Prisma.InputJsonValue, anonymisedPayload: Prisma.InputJsonValue): Promise<AthleteMedicalHistory> {
  if (!athleteId || !recordKind) throw new BadRequestError('athleteId + recordKind required');
  if (actor.role !== 'MEDICAL_STAFF' && actor.role !== 'SUPER_ADMIN' && actor.role !== 'CLUB_ADMIN' && actor.role !== 'HEAD_COACH') {
    throw new ForbiddenError('Insufficient role for medical history');
  }
  const payloadHash = createHash('sha256').update(JSON.stringify(plainPayload ?? null)).digest('hex');
  return prisma.athleteMedicalHistory.create({
    data: {
      athleteId,
      recordKind,
      payloadHash,
      payload: anonymisedPayload,
    },
  });
}

export async function listMedical(actor: IdentityActor, athleteId: string, recordKind?: string): Promise<AthleteMedicalHistory[]> {
  if (actor.role !== 'MEDICAL_STAFF' && actor.role !== 'SUPER_ADMIN' && actor.role !== 'CLUB_ADMIN' && actor.role !== 'HEAD_COACH') {
    throw new ForbiddenError('Insufficient role for medical history');
  }
  return prisma.athleteMedicalHistory.findMany({
    where: { athleteId, ...(recordKind ? { recordKind } : {}) },
    orderBy: { capturedAt: 'desc' },
    take: 200,
  });
}

// ── Transfer history ───────────────────────────────────────────────────

export async function recordTransfer(actor: IdentityActor, dto: { athleteId: string; fromClubRef?: string; toClubRef?: string; feeCents?: number; currency?: string; occurredAt: string; payload?: Prisma.InputJsonValue }): Promise<AthleteTransferHistory> {
  if (!dto.athleteId || !dto.occurredAt) throw new BadRequestError('athleteId + occurredAt required');
  return prisma.athleteTransferHistory.create({
    data: {
      athleteId:   dto.athleteId,
      fromClubRef: dto.fromClubRef ?? null,
      toClubRef:   dto.toClubRef ?? null,
      feeCents:    typeof dto.feeCents === 'number' ? BigInt(dto.feeCents) : null,
      currency:    dto.currency ?? 'EUR',
      occurredAt:  new Date(dto.occurredAt),
      payload:     (dto.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}

export async function listTransfers(athleteId: string): Promise<AthleteTransferHistory[]> {
  return prisma.athleteTransferHistory.findMany({ where: { athleteId }, orderBy: { occurredAt: 'desc' }, take: 100 });
}

// ── Talent evolution ───────────────────────────────────────────────────

export async function recordEvolutionSnapshot(_actor: IdentityActor, athleteId: string, snapshot: Prisma.InputJsonValue): Promise<TalentEvolutionGraph> {
  return prisma.talentEvolutionGraph.create({
    data: { athleteId, snapshot, modelVersion: 'n1' },
  });
}

export async function listEvolutionSnapshots(athleteId: string, limit = 50): Promise<TalentEvolutionGraph[]> {
  return prisma.talentEvolutionGraph.findMany({ where: { athleteId }, orderBy: { capturedAt: 'desc' }, take: Math.min(limit, 500) });
}
