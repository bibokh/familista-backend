// Familista — contract renewal
// ─────────────────────────────────────────────────────────────────────────────
// The fourth answer to "what do we do with this player". Selling him has three
// shapes — an auction, a private approach, a fixed price — and all three already
// live in transfer-market.service. Keeping him has one, and until now it had no
// server side at all: the panel said so and offered a disabled button.
//
// It reuses what is already there and adds no table:
//   • Player.weeklyWage / Player.contractUntil  — the terms themselves
//   • PlayerContractStatus                      — the club's record of them
// PlayerContractStatus.playerId is unique, so a renewal is an upsert against the
// row the listing code already maintains. Renewing twice renews the same
// contract; it never produces a second one, and it never touches Player rows,
// team assignment or membership.

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';
import { findActiveListingForPlayer, type MarketActor } from './transfer-market.service';

export interface RenewDto {
  weeklyWageEur: number;
  contractUntil: string;
  releaseClauseEur?: number | null;
}

// The renewal window. A contract that ends today is not a renewal, and one that
// runs for a human lifetime is a typo — both are refused by name rather than
// clamped into something the manager did not ask for.
const MIN_TERM_DAYS = 1;
const MAX_TERM_YEARS = 10;

// The same permissive reader the roster lift uses: an <input> hands back "45000",
// not 45000, and a number that was sent and cannot be read is refused rather
// than replaced by a plausible one.
function readMoney(v: unknown, where: string): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new BadRequestError(`${where} is not a finite number`);
    return v;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new BadRequestError(`${where} is not a number: ${JSON.stringify(v)}`);
    return n;
  }
  throw new BadRequestError(`${where} is required`);
}

// What the panel needs to show before anything is edited: the terms actually
// stored against him, not a figure derived from his rating.
export async function readContract(actor: MarketActor, playerId: string) {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    select: {
      id: true, clubId: true, teamId: true, isActive: true,
      firstName: true, lastName: true, weeklyWage: true, contractUntil: true,
    },
  });
  if (!player) throw new NotFoundError('Player');
  if (player.clubId !== actor.clubId) throw new ForbiddenError('That player belongs to another club');

  const status = await prisma.playerContractStatus.findUnique({ where: { playerId } });
  return {
    playerId:         player.id,
    teamId:           player.teamId,
    weeklyWageEur:    player.weeklyWage,
    contractUntil:    player.contractUntil,
    releaseClauseEur: status?.releaseClauseEur ?? null,
    contractExpiry:   status?.contractExpiry ?? null,
    isAvailableForTransfer: status?.isAvailableForTransfer ?? false,
  };
}

// Renewal is an owner-club action against a player the club owns. It asks
// nothing about which team he plays for: a First Team contract and an age
// group's contract are the same record with the same columns, so an academy
// player renews through exactly this path.
export async function renewContract(actor: MarketActor, playerId: string, dto: RenewDto) {
  const wage = Math.round(readMoney(dto?.weeklyWageEur, 'weeklyWageEur'));
  if (wage < 0) throw new BadRequestError('weeklyWageEur cannot be negative');

  if (!dto?.contractUntil || String(dto.contractUntil).trim() === '') {
    throw new BadRequestError('contractUntil is required');
  }
  const until = new Date(dto.contractUntil);
  if (Number.isNaN(until.getTime())) {
    throw new BadRequestError(`contractUntil is not a date: ${JSON.stringify(dto.contractUntil)}`);
  }
  const now = Date.now();
  if (until.getTime() < now + MIN_TERM_DAYS * 24 * 3600_000) {
    throw new BadRequestError('contractUntil must be in the future');
  }
  if (until.getTime() > now + MAX_TERM_YEARS * 365 * 24 * 3600_000) {
    throw new BadRequestError(`contractUntil cannot be more than ${MAX_TERM_YEARS} years away`);
  }

  let clause: number | null = null;
  if (dto.releaseClauseEur !== undefined && dto.releaseClauseEur !== null
      && String(dto.releaseClauseEur).trim() !== '') {
    clause = Math.round(readMoney(dto.releaseClauseEur, 'releaseClauseEur'));
    if (clause < 0) throw new BadRequestError('releaseClauseEur cannot be negative');
  }

  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player) throw new NotFoundError('Player');
  if (player.clubId !== actor.clubId) throw new ForbiddenError('That player belongs to another club');
  if (player.isActive === false) throw new BadRequestError('That player is not active');

  // A player the club is trying to sell is not a player it is re-signing. The
  // two answers contradict each other, so the manager is told which one is
  // already in flight instead of silently ending up with both.
  const listed = await findActiveListingForPlayer(playerId);
  if (listed) {
    throw new ConflictError('He is on the market — cancel the listing before renewing his contract');
  }

  const saved = await prisma.$transaction(async (tx) => {
    const updated = await tx.player.update({
      where: { id: playerId },
      data:  { weeklyWage: wage, contractUntil: until },
    });
    // One row per player, guaranteed by the unique key. A second renewal
    // rewrites the terms on the record the first one wrote.
    const status = await tx.playerContractStatus.upsert({
      where:  { playerId },
      update: {
        clubId:         player.clubId,
        contractExpiry: until,
        ...(clause === null ? {} : { releaseClauseEur: clause }),
        isExpiringSoon: false,
        updatedBy:      actor.userId,
      },
      create: {
        clubId:           player.clubId,
        playerId,
        contractExpiry:   until,
        releaseClauseEur: clause,
        isExpiringSoon:   false,
        updatedBy:        actor.userId,
      },
    });
    return { updated, status };
  });

  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'PLAYER_CONTRACT_RENEWED', entityType: 'Player', entityId: playerId,
    payload: {
      weeklyWageEur: wage,
      contractUntil: until.toISOString(),
      releaseClauseEur: clause,
      teamId: player.teamId ?? null,
    } as Prisma.InputJsonValue,
  });

  return {
    playerId,
    teamId:           saved.updated.teamId,
    weeklyWageEur:    saved.updated.weeklyWage,
    contractUntil:    saved.updated.contractUntil,
    releaseClauseEur: saved.status.releaseClauseEur ?? null,
  };
}
