// Familista — Club Operations (Phase O)
// ─────────────────────────────────────────────────────────────────────────
// Guardian links, training/match attendance, payment ledger, invoice lines,
// calendar entries. All tenant-isolated, all audit-anchored. No payment
// gateway — Phase O ships the ledger; integration is Phase P+.

import { AttendanceMark, ClubCalendarEntry, ClubEventKind, MatchAttendanceRecord, OperationsInvoiceLine, OperationsPayment, OperationsPaymentState, PlayerGuardianLink, Prisma, TrainingAttendanceRecord } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface OpsActor {
  userId: string;
  clubId: string;
  role?:  string;
}

async function assertPlayerInClub(playerId: string, clubId: string): Promise<void> {
  const p = await prisma.player.findUnique({ where: { id: playerId }, select: { clubId: true } });
  if (!p)                  throw new NotFoundError('Player');
  if (p.clubId !== clubId) throw new ForbiddenError('Player not in club');
}

// ── Guardians ───────────────────────────────────────────────────────────

export interface LinkGuardianDto {
  playerId:        string;
  guardianUserId:  string;
  relationship?:   string;
  isPrimary?:      boolean;
}

export async function linkGuardian(actor: OpsActor, dto: LinkGuardianDto): Promise<PlayerGuardianLink> {
  if (!dto.playerId || !dto.guardianUserId) throw new BadRequestError('playerId + guardianUserId required');
  await assertPlayerInClub(dto.playerId, actor.clubId);
  const row = await prisma.playerGuardianLink.upsert({
    where:  { playerId_guardianUserId: { playerId: dto.playerId, guardianUserId: dto.guardianUserId } },
    create: {
      clubId:        actor.clubId,
      playerId:      dto.playerId,
      guardianUserId: dto.guardianUserId,
      relationship:  dto.relationship ?? 'PARENT',
      isPrimary:     !!dto.isPrimary,
    },
    update: { relationship: dto.relationship ?? 'PARENT', isPrimary: !!dto.isPrimary },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'GUARDIAN_LINKED', entityType: 'PlayerGuardianLink', entityId: row.id,
    payload: { playerId: dto.playerId, guardianUserId: dto.guardianUserId, isPrimary: row.isPrimary },
  });
  return row;
}

export async function listGuardians(actor: OpsActor, playerId: string): Promise<PlayerGuardianLink[]> {
  await assertPlayerInClub(playerId, actor.clubId);
  return prisma.playerGuardianLink.findMany({ where: { playerId }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] });
}

export async function unlinkGuardian(actor: OpsActor, id: string): Promise<void> {
  const row = await prisma.playerGuardianLink.findUnique({ where: { id } });
  if (!row)                                                       throw new NotFoundError('PlayerGuardianLink');
  if (row.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  await prisma.playerGuardianLink.delete({ where: { id } });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'GUARDIAN_UNLINKED', entityType: 'PlayerGuardianLink', entityId: id,
    payload: { playerId: row.playerId },
  });
}

// ── Training attendance ─────────────────────────────────────────────────

export interface MarkTrainingAttendanceDto {
  trainingSessionId: string;
  playerId:          string;
  mark?:             AttendanceMark;
  notes?:            string;
}

export async function markTrainingAttendance(actor: OpsActor, dto: MarkTrainingAttendanceDto): Promise<TrainingAttendanceRecord> {
  if (!dto.trainingSessionId || !dto.playerId) throw new BadRequestError('trainingSessionId + playerId required');
  await assertPlayerInClub(dto.playerId, actor.clubId);
  // Verify training session belongs to the club (tenant gate).
  const ts = await prisma.trainingSession.findUnique({ where: { id: dto.trainingSessionId }, select: { clubId: true } });
  if (!ts)                  throw new NotFoundError('TrainingSession');
  if (ts.clubId !== actor.clubId) throw new ForbiddenError('Training session not in club');
  return prisma.trainingAttendanceRecord.upsert({
    where:  { trainingSessionId_playerId: { trainingSessionId: dto.trainingSessionId, playerId: dto.playerId } },
    create: {
      clubId: actor.clubId, trainingSessionId: dto.trainingSessionId, playerId: dto.playerId,
      mark: dto.mark ?? 'PRESENT', notes: dto.notes ?? null, recordedById: actor.userId,
    },
    update: { mark: dto.mark ?? 'PRESENT', notes: dto.notes ?? null, recordedById: actor.userId, recordedAt: new Date() },
  });
}

export async function listTrainingAttendance(actor: OpsActor, trainingSessionId: string): Promise<TrainingAttendanceRecord[]> {
  return prisma.trainingAttendanceRecord.findMany({
    where: { clubId: actor.clubId, trainingSessionId },
    orderBy: { recordedAt: 'desc' },
    take: 200,
  });
}

// ── Match attendance ────────────────────────────────────────────────────

export interface MarkMatchAttendanceDto {
  matchId:        string;
  playerId:       string;
  mark?:          AttendanceMark;
  minutesOnPitch?: number;
  notes?:         string;
}

export async function markMatchAttendance(actor: OpsActor, dto: MarkMatchAttendanceDto): Promise<MatchAttendanceRecord> {
  if (!dto.matchId || !dto.playerId) throw new BadRequestError('matchId + playerId required');
  await assertPlayerInClub(dto.playerId, actor.clubId);
  const m = await prisma.match.findUnique({ where: { id: dto.matchId }, select: { clubId: true } });
  if (!m)                  throw new NotFoundError('Match');
  if (m.clubId !== actor.clubId) throw new ForbiddenError('Match not in club');
  return prisma.matchAttendanceRecord.upsert({
    where:  { matchId_playerId: { matchId: dto.matchId, playerId: dto.playerId } },
    create: {
      clubId: actor.clubId, matchId: dto.matchId, playerId: dto.playerId,
      mark: dto.mark ?? 'PRESENT', minutesOnPitch: dto.minutesOnPitch ?? null,
      notes: dto.notes ?? null, recordedById: actor.userId,
    },
    update: {
      mark: dto.mark ?? 'PRESENT', minutesOnPitch: dto.minutesOnPitch ?? null,
      notes: dto.notes ?? null, recordedById: actor.userId, recordedAt: new Date(),
    },
  });
}

export async function listMatchAttendance(actor: OpsActor, matchId: string): Promise<MatchAttendanceRecord[]> {
  return prisma.matchAttendanceRecord.findMany({
    where: { clubId: actor.clubId, matchId },
    orderBy: { recordedAt: 'desc' },
    take: 200,
  });
}

// ── Payment ledger ──────────────────────────────────────────────────────

export interface CreatePaymentDto {
  payerUserId?:   string;
  payerPlayerId?: string;
  amountCents:    number;
  currency?:      string;
  category:       string;
  dueDate?:       string;
  invoiceRef?:    string;
  notes?:         string;
}

export async function createPayment(actor: OpsActor, dto: CreatePaymentDto): Promise<OperationsPayment> {
  if (!Number.isInteger(dto.amountCents) || dto.amountCents < 0) throw new BadRequestError('amountCents must be non-negative integer');
  if (!dto.category) throw new BadRequestError('category required');
  if (dto.payerPlayerId) await assertPlayerInClub(dto.payerPlayerId, actor.clubId);
  const row = await prisma.operationsPayment.create({
    data: {
      clubId:        actor.clubId,
      payerUserId:   dto.payerUserId ?? null,
      payerPlayerId: dto.payerPlayerId ?? null,
      amountCents:   dto.amountCents,
      currency:      dto.currency ?? 'EUR',
      category:      dto.category,
      dueDate:       dto.dueDate ? new Date(dto.dueDate) : null,
      invoiceRef:    dto.invoiceRef ?? null,
      notes:         dto.notes ?? null,
    },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'PAYMENT_CREATED', entityType: 'OperationsPayment', entityId: row.id,
    payload: { amountCents: dto.amountCents, currency: row.currency, category: row.category },
  });
  return row;
}

export async function setPaymentState(actor: OpsActor, id: string, state: OperationsPaymentState, paidAt?: string): Promise<OperationsPayment> {
  const p = await prisma.operationsPayment.findUnique({ where: { id } });
  if (!p)                                                       throw new NotFoundError('OperationsPayment');
  if (p.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  const updated = await prisma.operationsPayment.update({
    where: { id },
    data:  { state, ...(state === 'PAID' ? { paidAt: paidAt ? new Date(paidAt) : new Date() } : {}) },
  });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'PAYMENT_STATE_CHANGED', entityType: 'OperationsPayment', entityId: id,
    payload: { state },
  });
  return updated;
}

export async function listPayments(actor: OpsActor, opts: { state?: OperationsPaymentState; payerPlayerId?: string; limit?: number; page?: number } = {}) {
  const { page = 1, limit = 50 } = opts;
  const where: Prisma.OperationsPaymentWhereInput = {
    clubId: actor.clubId,
    ...(opts.state         ? { state: opts.state } : {}),
    ...(opts.payerPlayerId ? { payerPlayerId: opts.payerPlayerId } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.operationsPayment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: Math.min(limit, 200) }),
    prisma.operationsPayment.count({ where }),
  ]);
  return { items, total, page, limit };
}

// ── Invoice line items ──────────────────────────────────────────────────

export async function addInvoiceLine(actor: OpsActor, invoiceDraftId: string, dto: { label: string; quantity?: number; unitCents?: number }): Promise<OperationsInvoiceLine> {
  if (!invoiceDraftId || !dto.label) throw new BadRequestError('invoiceDraftId + label required');
  // Verify invoice belongs to a billing account in this club.
  const inv = await prisma.invoiceDraft.findUnique({ where: { id: invoiceDraftId }, select: { billingAccountId: true } });
  if (!inv) throw new NotFoundError('InvoiceDraft');
  const acct = await prisma.billingAccount.findUnique({ where: { id: inv.billingAccountId }, select: { clubId: true } });
  if (!acct || (acct.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN')) throw new ForbiddenError();
  const qty = Math.max(1, dto.quantity ?? 1);
  const unit = Math.max(0, dto.unitCents ?? 0);
  return prisma.operationsInvoiceLine.create({
    data: { invoiceDraftId, label: dto.label, quantity: qty, unitCents: unit, totalCents: qty * unit },
  });
}

export async function listInvoiceLines(invoiceDraftId: string): Promise<OperationsInvoiceLine[]> {
  return prisma.operationsInvoiceLine.findMany({ where: { invoiceDraftId }, orderBy: { createdAt: 'asc' } });
}

// ── Calendar ────────────────────────────────────────────────────────────

export interface CreateCalendarDto {
  teamId?:    string;
  kind?:      ClubEventKind;
  title:      string;
  startsAt:   string;
  endsAt?:    string;
  location?:  string;
  payload?:   Prisma.InputJsonValue;
  externalRef?: string;
}

export async function createCalendarEntry(actor: OpsActor, dto: CreateCalendarDto): Promise<ClubCalendarEntry> {
  if (!dto.title || !dto.startsAt) throw new BadRequestError('title + startsAt required');
  return prisma.clubCalendarEntry.create({
    data: {
      clubId:      actor.clubId,
      teamId:      dto.teamId ?? null,
      kind:        dto.kind ?? 'OTHER',
      title:       dto.title,
      startsAt:    new Date(dto.startsAt),
      endsAt:      dto.endsAt ? new Date(dto.endsAt) : null,
      location:    dto.location ?? null,
      payload:     (dto.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      externalRef: dto.externalRef ?? null,
      createdById: actor.userId,
    },
  });
}

export async function listCalendar(actor: OpsActor, opts: { teamId?: string; fromIso?: string; toIso?: string; limit?: number } = {}): Promise<ClubCalendarEntry[]> {
  return prisma.clubCalendarEntry.findMany({
    where: {
      clubId: actor.clubId,
      ...(opts.teamId ? { teamId: opts.teamId } : {}),
      ...((opts.fromIso || opts.toIso) ? {
        startsAt: {
          ...(opts.fromIso ? { gte: new Date(opts.fromIso) } : {}),
          ...(opts.toIso   ? { lte: new Date(opts.toIso) }   : {}),
        },
      } : {}),
    },
    orderBy: { startsAt: 'asc' },
    take: Math.min(opts.limit ?? 100, 1000),
  });
}
