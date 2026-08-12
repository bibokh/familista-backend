// Familista — Club-to-club transfer market
// ─────────────────────────────────────────────────────────────────────────────
// The marketplace already had listings, but a listing is not a market. Reading
// it was hard-scoped to your own club, a TRANSFER_LISTING could never leave
// DRAFT, and nothing existed that moved a player from one club to another. This
// module supplies exactly those three things and nothing else.
//
// It reuses what is already there:
//   • MarketplaceItem / TRANSFER_LISTING  — the listing itself
//   • Player.clubId + Player.teamId       — who owns the footballer
//   • PlayerContractStatus.isAvailableForTransfer — that he is on the market
//   • AthleteTransferHistory              — the completed move
// and adds one small table, ClubTransferBalance, because a sale needs a buyer
// who can pay and a seller who gets paid, and no such figure existed.
//
// The rule that makes a market safe is separation: WHO MAY SEE a listing and
// WHO MAY CHANGE it are different questions. Every club may see another club's
// active listings; only the owner may delist one; only somebody else may buy it.

import { MarketplaceItem, Player, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { appendAuditEventAsync } from '../security/audit-chain.service';

export interface MarketActor { userId: string; clubId: string; role?: string }

const KIND = 'TRANSFER_LISTING' as const;

// ── money ────────────────────────────────────────────────────────────────────
export async function ensureBalance(clubId: string) {
  return prisma.clubTransferBalance.upsert({
    where:  { clubId },
    update: {},
    create: { clubId },
  });
}
export async function getBalance(clubId: string) {
  const b = await ensureBalance(clubId);
  return {
    clubId,
    budgetEur: Number(b.budgetEur),
    earnedEur: Number(b.earnedEur),
    spentEur:  Number(b.spentEur),
    // what the club may actually commit to a deal right now
    availableEur: Number(b.budgetEur) + Number(b.earnedEur) - Number(b.spentEur),
  };
}

// ── bootstrap ────────────────────────────────────────────────────────────────
// A club that has never had persistent players gets its current roster lifted
// into real Player rows ONCE. The guard is the club's own player count, so a
// second call — a reload, a retry, a second tab — adds nobody. Each team is
// keyed by name within the club, which is the uniqueness the schema already
// declares, so an age group can never be created twice or merged into another.
export interface BootstrapTeamDto {
  name: string;
  kind?: string;
  ageMin?: number;
  ageMax?: number;
  players: Array<{
    firstName: string; lastName: string; number: number; position: string;
    nationality?: string; flag?: string; dateOfBirth?: string; height?: number;
    weight?: number; preferredFoot?: string; overallRating?: number;
    potential?: number; condition?: number; marketValue?: number; weeklyWage?: number;
  }>;
}

export async function bootstrapRoster(actor: MarketActor, teams: BootstrapTeamDto[]) {
  if (!Array.isArray(teams) || !teams.length) throw new BadRequestError('teams[] required');

  const existing = await prisma.player.count({ where: { clubId: actor.clubId, isActive: true } });
  if (existing > 0) {
    // Already persistent. Hand back what is there; never seed a second time.
    const players = await prisma.player.findMany({ where: { clubId: actor.clubId, isActive: true } });
    return { seeded: false, reason: 'club already has persistent players', players };
  }

  await prisma.$transaction(async (tx) => {
    for (const t of teams) {
      const team = await tx.team.upsert({
        where:  { clubId_name: { clubId: actor.clubId, name: t.name } },
        update: {},
        create: {
          clubId: actor.clubId, name: t.name,
          kind:   (t.kind as never) ?? ('SENIOR' as never),
          ageMin: t.ageMin ?? null, ageMax: t.ageMax ?? null,
        },
      });
      for (const p of t.players) {
        await tx.player.create({
          data: {
            clubId: actor.clubId, teamId: team.id,
            firstName: p.firstName, lastName: p.lastName, number: p.number,
            position: (p.position as never), nationality: p.nationality ?? '—', flag: p.flag ?? '🏳️',
            dateOfBirth: p.dateOfBirth ? new Date(p.dateOfBirth) : new Date('2000-01-01'),
            height: p.height ?? 180, weight: p.weight ?? 75,
            preferredFoot: (p.preferredFoot as never) ?? ('RIGHT' as never),
            overallRating: p.overallRating ?? 70, potential: p.potential ?? 75,
            condition: p.condition ?? 90, marketValue: p.marketValue ?? 1000000,
            weeklyWage: p.weeklyWage ?? 10000,
          },
        });
      }
    }
  });

  const players = await prisma.player.findMany({ where: { clubId: actor.clubId, isActive: true } });
  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'ROSTER_BOOTSTRAPPED', entityType: 'Club', entityId: actor.clubId,
    payload: { teams: teams.length, players: players.length },
  });
  return { seeded: true, players };
}

// ── listing ──────────────────────────────────────────────────────────────────
export interface ListDto { playerId: string; askingPriceEur: number; validUntil?: string }

// A club lists a player it owns. He does NOT leave the squad — being for sale
// and being sold are different states, and only the second one moves anybody.
export async function listPlayer(actor: MarketActor, dto: ListDto): Promise<MarketplaceItem> {
  if (!dto?.playerId || typeof dto.askingPriceEur !== 'number' || dto.askingPriceEur < 0) {
    throw new BadRequestError('playerId + askingPriceEur required');
  }
  const player = await prisma.player.findUnique({ where: { id: dto.playerId } });
  if (!player)                     throw new NotFoundError('Player');
  if (player.clubId !== actor.clubId) throw new ForbiddenError('That player belongs to another club');
  if (player.isActive === false)   throw new BadRequestError('That player is not active');

  const open = await findActiveListingForPlayer(dto.playerId);
  if (open) return open;                        // listing twice is the same listing

  const row = await prisma.$transaction(async (tx) => {
    const item = await tx.marketplaceItem.create({
      data: {
        clubId:      actor.clubId,
        kind:        KIND,
        title:       `${player.firstName} ${player.lastName} · ${player.position}`,
        description: null,
        status:      'ACTIVE',
        validFrom:   new Date(),
        validUntil:  dto.validUntil ? new Date(dto.validUntil) : null,
        createdById: actor.userId,
        payload: {
          playerId:       player.id,
          sellerClubId:   actor.clubId,
          sellerTeamId:   player.teamId ?? null,
          askingPriceEur: Math.round(dto.askingPriceEur),
        } as Prisma.InputJsonValue,
      },
    });
    await setAvailability(tx, player, actor, true);
    return item;
  });

  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'TRANSFER_LISTED', entityType: 'MarketplaceItem', entityId: row.id,
    payload: { playerId: player.id, askingPriceEur: Math.round(dto.askingPriceEur) },
  });
  return row;
}

// Only the owner may take his player off the market. No money moves, and the
// player was never anywhere but his own squad.
export async function delistPlayer(actor: MarketActor, listingId: string): Promise<MarketplaceItem> {
  const item = await prisma.marketplaceItem.findUnique({ where: { id: listingId } });
  if (!item || item.kind !== KIND) throw new NotFoundError('Transfer listing');
  if (item.clubId !== actor.clubId) throw new ForbiddenError('Only the selling club may delist');
  if (item.status !== 'ACTIVE') return item;

  const payload = item.payload as Record<string, unknown> | null;
  const playerId = payload && typeof payload.playerId === 'string' ? payload.playerId : null;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.marketplaceItem.update({ where: { id: listingId }, data: { status: 'CLOSED' } });
    if (playerId) {
      const p = await tx.player.findUnique({ where: { id: playerId } });
      if (p) await setAvailability(tx, p, actor, false);
    }
    return updated;
  });
}

// ── market visibility ────────────────────────────────────────────────────────
// Every authenticated club sees every OTHER club's active listings. Visibility
// is not ownership: nothing here lets the reader change what it can see, and a
// club is never shown its own player as something to buy.
export async function readMarket(actor: MarketActor, opts: { page?: number; limit?: number } = {}) {
  const { page = 1, limit = 50 } = opts;
  const where: Prisma.MarketplaceItemWhereInput = {
    kind:   KIND,
    status: 'ACTIVE',
    clubId: { not: actor.clubId },
    OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
  };
  const [items, total] = await Promise.all([
    prisma.marketplaceItem.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: Math.min(limit, 200) }),
    prisma.marketplaceItem.count({ where }),
  ]);
  const listings = await Promise.all(items.map(hydrateListing));
  return { items: listings.filter(Boolean), total, page, limit };
}

// A club's own listings, for its own management surface — clearly the other
// question, answered by a different call.
export async function readOwnListings(actor: MarketActor) {
  const items = await prisma.marketplaceItem.findMany({
    where: { kind: KIND, clubId: actor.clubId, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' }, take: 200,
  });
  const listings = await Promise.all(items.map(hydrateListing));
  return { items: listings.filter(Boolean) };
}

// ── settlement ───────────────────────────────────────────────────────────────
// The four movements, in one database transaction. The listing is claimed by a
// conditional update: only a row still ACTIVE can be flipped to CLOSED, and only
// one transaction can win that flip. Everything else in the transaction happens
// downstream of the claim, so a second buyer, a double-click and a retried
// request all reach the same place — `claimed.count === 0` — and stop there.
export async function purchase(actor: MarketActor, listingId: string) {
  const item = await prisma.marketplaceItem.findUnique({ where: { id: listingId } });
  if (!item || item.kind !== KIND)  throw new NotFoundError('Transfer listing');
  if (item.clubId === actor.clubId) throw new ForbiddenError('A club cannot buy its own player');
  if (item.status !== 'ACTIVE')     throw new ConflictError('Listing no longer available');

  const payload = (item.payload ?? {}) as Record<string, unknown>;
  const playerId = typeof payload.playerId === 'string' ? payload.playerId : null;
  const feeEur   = typeof payload.askingPriceEur === 'number' ? Math.round(payload.askingPriceEur) : null;
  if (!playerId || feeEur === null) throw new BadRequestError('Listing is missing its player or price');

  const buyerBalance = await getBalance(actor.clubId);
  if (buyerBalance.availableEur < feeEur) throw new BadRequestError('Insufficient transfer budget');

  const result = await prisma.$transaction(async (tx) => {
    // ── the claim. Exactly one caller can take a listing out of ACTIVE. ──
    const claimed = await tx.marketplaceItem.updateMany({
      where: { id: listingId, kind: KIND, status: 'ACTIVE' },
      data:  { status: 'CLOSED' },
    });
    if (claimed.count === 0) throw new ConflictError('Listing no longer available');

    const player = await tx.player.findUnique({ where: { id: playerId } });
    if (!player) throw new NotFoundError('Player');
    if (player.clubId !== item.clubId) throw new ConflictError('That player no longer belongs to the selling club');

    // 1 + 2 · the same Player row changes hands. One identity, one record.
    const buyerTeam = await defaultTeamFor(tx, actor.clubId, player.position);
    await tx.player.update({
      where: { id: playerId },
      data:  { clubId: actor.clubId, teamId: buyerTeam?.id ?? null },
    });

    // 3 · the buyer pays, once
    await tx.clubTransferBalance.upsert({
      where:  { clubId: actor.clubId },
      update: { spentEur: { increment: BigInt(feeEur) } },
      create: { clubId: actor.clubId, spentEur: BigInt(feeEur) },
    });
    // 4 · the seller is paid, once
    await tx.clubTransferBalance.upsert({
      where:  { clubId: item.clubId },
      update: { earnedEur: { increment: BigInt(feeEur) } },
      create: { clubId: item.clubId, earnedEur: BigInt(feeEur) },
    });

    // he is no longer for sale
    await tx.playerContractStatus.updateMany({
      where: { playerId }, data: { isAvailableForTransfer: false },
    });

    // one completed transfer, in the shape the platform already records
    const history = await tx.athleteTransferHistory.create({
      data: {
        athleteId:   playerId,
        fromClubRef: item.clubId,
        toClubRef:   actor.clubId,
        feeCents:    BigInt(feeEur) * BigInt(100),
        currency:    'EUR',
        occurredAt:  new Date(),
        payload:     { listingId, fromTeamId: player.teamId ?? null, toTeamId: buyerTeam?.id ?? null } as Prisma.InputJsonValue,
      },
    });
    return { playerId, feeEur, historyId: history.id, sellerClubId: item.clubId, buyerClubId: actor.clubId };
  });

  appendAuditEventAsync({
    actor: { userId: actor.userId, clubId: actor.clubId, ipAddress: null, userAgent: null },
    action: 'TRANSFER_SETTLED', entityType: 'MarketplaceItem', entityId: listingId,
    payload: { playerId: result.playerId, feeEur: result.feeEur, from: result.sellerClubId, to: result.buyerClubId },
  });
  return result;
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function findActiveListingForPlayer(playerId: string): Promise<MarketplaceItem | null> {
  const rows = await prisma.marketplaceItem.findMany({ where: { kind: KIND, status: 'ACTIVE' }, take: 500 });
  return rows.find((r) => {
    const pl = (r.payload ?? {}) as Record<string, unknown>;
    return pl.playerId === playerId;
  }) ?? null;
}

async function hydrateListing(item: MarketplaceItem) {
  const pl = (item.payload ?? {}) as Record<string, unknown>;
  const playerId = typeof pl.playerId === 'string' ? pl.playerId : null;
  if (!playerId) return null;
  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player) return null;
  const club = await prisma.club.findUnique({ where: { id: item.clubId }, select: { id: true, name: true, shortName: true } });
  return {
    listingId:      item.id,
    status:         item.status,
    askingPriceEur: typeof pl.askingPriceEur === 'number' ? pl.askingPriceEur : 0,
    validUntil:     item.validUntil,
    createdAt:      item.createdAt,
    sellerClubId:   item.clubId,
    sellerClubName: club?.name ?? 'Unknown club',
    sellerTeamId:   typeof pl.sellerTeamId === 'string' ? pl.sellerTeamId : null,
    player,
  };
}

// PlayerContractStatus is the platform's existing record of whether a player may
// be transferred; keeping it truthful is part of listing, not a second store.
async function setAvailability(
  tx: Prisma.TransactionClient, player: Player, actor: MarketActor, on: boolean,
) {
  const existing = await tx.playerContractStatus.findUnique({ where: { playerId: player.id } });
  if (existing) {
    await tx.playerContractStatus.update({
      where: { playerId: player.id },
      data:  { isAvailableForTransfer: on, updatedBy: actor.userId },
    });
    return;
  }
  await tx.playerContractStatus.create({
    data: {
      clubId: player.clubId, playerId: player.id,
      contractExpiry: player.contractUntil ?? new Date(Date.now() + 365 * 24 * 3600_000),
      isAvailableForTransfer: on, updatedBy: actor.userId,
    },
  });
}

// Where a bought player lands. The buying club's senior team unless it has none,
// in which case he is club-owned but unassigned — never silently dropped.
async function defaultTeamFor(tx: Prisma.TransactionClient, clubId: string, _position: string) {
  return tx.team.findFirst({ where: { clubId, isActive: true, kind: 'SENIOR' }, orderBy: { createdAt: 'asc' } })
      ?? tx.team.findFirst({ where: { clubId, isActive: true }, orderBy: { createdAt: 'asc' } });
}
