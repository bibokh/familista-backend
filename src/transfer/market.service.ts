// Familista — Transfer Intelligence: Market Values & Contracts (Phase Q)
// Target: src/transfer/market.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// PlayerMarketValue — append-only valuation history.
//   Each call to recordMarketValue() inserts a new row; existing rows are never
//   mutated. Trend analysis can be derived by querying the full history.
//
// PlayerContractStatus — single mutable "live state" record per player.
//   Upserted on every change. isExpiringSoon is recomputed on every upsert
//   and refreshed nightly by ContractMonitorWorker.
//
// refreshExpiryFlags() is called by the worker to re-evaluate all contracts
// club-wide without a full upsert (only flips the boolean when it changes).

import { Prisma, PlayerMarketValue, PlayerContractStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';

export interface MarketActor {
  userId: string;
  clubId: string;
  role?:  string;
}

// ─── Market Values ────────────────────────────────────────────────────────────

export interface RecordMarketValueDto {
  playerId:      string;
  valuationDate: string;    // ISO date
  valueMEur:     number;    // market value in millions of euros
  source:        string;    // e.g. "TRANSFERMARKT" | "INTERNAL" | "AGENT" | "WYSCOUT"
  notes?:        string;
}

/**
 * Append a new market value entry.
 * Immutable history — never updates existing rows.
 */
export async function recordMarketValue(
  actor: MarketActor,
  dto: RecordMarketValueDto,
): Promise<PlayerMarketValue> {
  if (dto.valueMEur < 0) throw new BadRequestError('valueMEur cannot be negative');
  if (!dto.source.trim()) throw new BadRequestError('source is required');

  const player = await prisma.player.findUnique({ where: { id: dto.playerId }, select: { id: true } });
  if (!player) throw new NotFoundError('Player');

  return prisma.playerMarketValue.create({
    data: {
      clubId:        actor.clubId,
      playerId:      dto.playerId,
      valuationDate: new Date(dto.valuationDate),
      valueMEur:     dto.valueMEur,
      source:        dto.source.trim(),
      notes:         dto.notes ?? null,
      recordedBy:    actor.userId,
    },
  });
}

export async function getMarketValueHistory(
  actor: MarketActor,
  playerId: string,
): Promise<PlayerMarketValue[]> {
  const player = await prisma.player.findUnique({ where: { id: playerId }, select: { id: true } });
  if (!player) throw new NotFoundError('Player');

  return prisma.playerMarketValue.findMany({
    where:   { playerId, clubId: actor.clubId },
    orderBy: { valuationDate: 'asc' },
  });
}

export async function getLatestMarketValue(
  actor: MarketActor,
  playerId: string,
): Promise<PlayerMarketValue | null> {
  return prisma.playerMarketValue.findFirst({
    where:   { playerId, clubId: actor.clubId },
    orderBy: { valuationDate: 'desc' },
  });
}

/**
 * Return a squad-level valuation summary (total + latest value per player).
 * Used by the transfer room dashboard.
 */
export async function squadValuationSummary(
  actor: MarketActor,
  teamId?: string,
): Promise<{ playerId: string; latestValueMEur: number; valuationDate: Date }[]> {
  // Fetch all latest valuations for the club in one query using a subquery approach.
  const latest = await prisma.playerMarketValue.findMany({
    where: {
      clubId: actor.clubId,
      ...(teamId
        ? { player: { teamId } }
        : {}),
    },
    orderBy: { valuationDate: 'desc' },
    distinct: ['playerId'],
    select: { playerId: true, valueMEur: true, valuationDate: true },
  });

  return latest.map((r) => ({
    playerId:        r.playerId,
    latestValueMEur: r.valueMEur,
    valuationDate:   r.valuationDate,
  }));
}

// ─── Contract Status ──────────────────────────────────────────────────────────

export interface UpsertContractStatusDto {
  playerId:               string;
  contractExpiry:         string;     // ISO date
  contractValueEur?:      number;     // annual gross salary in euros
  releaseClauseEur?:      number;     // release clause value in euros
  agentName?:             string;
  agentContact?:          string;
  expiryAlertDays?:       number;     // days before expiry to raise alert (default 180)
  isAvailableForTransfer?: boolean;
  notes?:                 string;
}

/**
 * Upsert the current contract status for a player.
 * One record per player — always reflects the live contract state.
 * isExpiringSoon is computed from today's date on every call.
 */
export async function upsertContractStatus(
  actor: MarketActor,
  dto: UpsertContractStatusDto,
): Promise<PlayerContractStatus> {
  const player = await prisma.player.findUnique({ where: { id: dto.playerId }, select: { id: true } });
  if (!player) throw new NotFoundError('Player');

  const alertDays    = dto.expiryAlertDays ?? 180;
  const expiryDate   = new Date(dto.contractExpiry);
  const today        = new Date();
  const daysToExpiry = Math.floor((expiryDate.getTime() - today.getTime()) / 86_400_000);
  const isExpiringSoon = daysToExpiry >= 0 && daysToExpiry <= alertDays;

  const data = {
    clubId:                actor.clubId,
    playerId:              dto.playerId,
    contractExpiry:        expiryDate,
    contractValueEur:      dto.contractValueEur      ?? null,
    releaseClauseEur:      dto.releaseClauseEur       ?? null,
    agentName:             dto.agentName              ?? null,
    agentContact:          dto.agentContact           ?? null,
    expiryAlertDays:       alertDays,
    isExpiringSoon,
    isAvailableForTransfer: dto.isAvailableForTransfer ?? false,
    notes:                 dto.notes ?? null,
    updatedBy:             actor.userId,
    updatedAt:             new Date(),
  };

  return prisma.playerContractStatus.upsert({
    where:  { playerId: dto.playerId } as Prisma.PlayerContractStatusWhereUniqueInput,
    create: { ...data } as unknown as Prisma.PlayerContractStatusUncheckedCreateInput,
    update: { ...data } as Prisma.PlayerContractStatusUpdateInput,
  });
}

export async function getContractStatus(
  actor: MarketActor,
  playerId: string,
): Promise<PlayerContractStatus | null> {
  const cs = await prisma.playerContractStatus.findUnique({ where: { playerId } });
  if (!cs) return null;
  if (cs.clubId !== actor.clubId && actor.role !== 'SUPER_ADMIN') throw new ForbiddenError();
  return cs;
}

/**
 * Return all contracts expiring within withinDays for this club.
 * Called by the daily alert worker to queue renewal reminder notifications.
 */
export async function getExpiringContracts(
  actor: MarketActor,
  withinDays = 180,
): Promise<PlayerContractStatus[]> {
  const threshold = new Date(Date.now() + withinDays * 86_400_000);
  return prisma.playerContractStatus.findMany({
    where: {
      clubId:                 actor.clubId,
      contractExpiry:         { lte: threshold },
      isAvailableForTransfer: false,   // already in transfer mode — exclude
    },
    orderBy: { contractExpiry: 'asc' },
  });
}

/**
 * Nightly worker entry point: refresh isExpiringSoon flags for all contracts
 * club-wide. Only writes rows where the flag actually changed.
 */
export async function refreshExpiryFlags(clubId: string): Promise<{ updated: number }> {
  const contracts = await prisma.playerContractStatus.findMany({ where: { clubId } });
  const today = new Date();
  let updated = 0;

  for (const c of contracts) {
    const daysToExpiry  = Math.floor((c.contractExpiry.getTime() - today.getTime()) / 86_400_000);
    const shouldBeAlert = daysToExpiry >= 0 && daysToExpiry <= c.expiryAlertDays;

    if (shouldBeAlert !== c.isExpiringSoon) {
      await prisma.playerContractStatus.update({
        where: { id: c.id },
        data:  { isExpiringSoon: shouldBeAlert, updatedAt: new Date() },
      });
      updated++;
    }
  }

  return { updated };
}
